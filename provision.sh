#!/usr/bin/env bash
# nodewatch — AllStar Remote Node Provisioning Script
#
# Configures the Asterisk Manager Interface on a remote AllStar node and
# registers it with the nodewatch server — no manual credential entry needed.
#
# Required environment variables (provided by the command from the nodewatch UI):
#   NODEWATCH_URL  — e.g. http://192.168.1.100:8080
#   TOKEN_ID       — one-time registration token (10-minute expiry)
#   KEY_HEX        — AES-256 encryption key (64 hex chars)
#   IV_HEX         — AES-256 IV (32 hex chars)
#
# What this does:
#   1. Reads your Asterisk config (rpt.conf, manager.conf)
#   2. Creates a dedicated AMI user "nodewatch" with a random password
#   3. Restricts AMI access to only the nodewatch server IP
#   4. Opens firewall port 5038 from the nodewatch server
#   5. Reloads the Asterisk Manager
#   6. Encrypts credentials and sends them to nodewatch
#   7. nodewatch saves the node and restarts automatically

set -euo pipefail

G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1;34m'; NC='\033[0m'
ok()   { echo -e "${G}  ✓${NC}  $*"; }
warn() { echo -e "${Y}  !${NC}  $*"; }
step() { echo -e "\n${B}▶${NC}  $*"; }
die()  { echo -e "\n${R}  ✗  ERROR:${NC} $*" >&2; exit 1; }

# ── Validate env vars ──────────────────────────────────────────────────────────
for V in NODEWATCH_URL TOKEN_ID KEY_HEX IV_HEX; do
  [[ -n "${!V:-}" ]] || die "Required env var $V is not set. Use the full command from the nodewatch UI."
done

# ── Require root ───────────────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || die "Run as root (prepend sudo env ... to the command)"

# ── Check required tools ───────────────────────────────────────────────────────
step "Checking prerequisites..."
for T in openssl curl python3; do
  command -v "$T" &>/dev/null && ok "$T found" || die "$T is required but not installed"
done
[[ -f /etc/asterisk/rpt.conf    ]] || die "/etc/asterisk/rpt.conf not found. Is AllStar/Asterisk installed?"
[[ -f /etc/asterisk/manager.conf ]] || die "/etc/asterisk/manager.conf not found"

# ── Read node numbers ──────────────────────────────────────────────────────────
step "Reading Asterisk configuration..."
mapfile -t NODES < <(awk '
  /^\[nodes\]/ { s=1; next }
  /^\[/        { s=0 }
  s && /^[0-9]+ *=/ { print $1 }
' /etc/asterisk/rpt.conf)
[[ ${#NODES[@]} -gt 0 ]] || die "No node numbers found in /etc/asterisk/rpt.conf [nodes] section"
ok "AllStar node(s): ${NODES[*]}"

# ── Determine nodewatch server host (strip protocol/port) ──────────────────────
NW_HOST=$(echo "$NODEWATCH_URL" | sed 's|https\?://||;s|[:/].*||')
ok "Nodewatch server: $NW_HOST"

# ── Generate random AMI password ───────────────────────────────────────────────
AMI_USER="nodewatch"
AMI_PASS=$(tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24 || openssl rand -hex 12)
ok "Generated AMI credentials for [$AMI_USER]"

# ── Update manager.conf ────────────────────────────────────────────────────────
step "Updating /etc/asterisk/manager.conf..."
cp /etc/asterisk/manager.conf "/etc/asterisk/manager.conf.nw_$(date +%Y%m%d_%H%M%S).bak"

python3 - /etc/asterisk/manager.conf "$NW_HOST" "$AMI_USER" "$AMI_PASS" << 'PYEOF'
import sys, re

conf_path, nw_host, ami_user, ami_pass = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

with open(conf_path) as f:
    txt = f.read()

# Ensure [general] has enabled=yes and bindaddr=0.0.0.0
def patch_general(m):
    body = m.group(0)
    for key, val in [('enabled', 'yes'), ('bindaddr', '0.0.0.0')]:
        if re.search(r'(?m)^' + key + r'\s*=', body):
            body = re.sub(r'(?m)^' + key + r'\s*=.*', key + ' = ' + val, body)
        else:
            body = body.rstrip() + '\n' + key + ' = ' + val + '\n'
    return body

if '[general]' in txt:
    txt = re.sub(r'\[general\].*?(?=\[|\Z)', patch_general, txt, flags=re.DOTALL)
else:
    txt = '[general]\nenabled = yes\nbindaddr = 0.0.0.0\nport = 5038\n\n' + txt

# Remove existing [nodewatch] stanza if present
txt = re.sub(r'\[' + re.escape(ami_user) + r'\].*?(?=\[|\Z)', '', txt, flags=re.DOTALL)

# Append fresh stanza
stanza = (
    '\n[' + ami_user + ']\n'
    'secret = ' + ami_pass + '\n'
    'deny = 0.0.0.0/0.0.0.0\n'
    'permit = ' + nw_host + '/255.255.255.255\n'
    'read = system,call,log,verbose,agent,user,config,dtmf,reporting,cdr,dialplan\n'
    'write = system,call,agent,user,config,command,reporting,originate\n'
)
txt = txt.rstrip() + '\n' + stanza

with open(conf_path, 'w') as f:
    f.write(txt)
print('  Updated ' + conf_path)
PYEOF
ok "manager.conf updated (backup saved)"

# ── Update firewall ────────────────────────────────────────────────────────────
step "Updating firewall rules..."
FW_DONE=0

if command -v ufw &>/dev/null && ufw status 2>/dev/null | grep -qw active; then
    ufw allow from "$NW_HOST" to any port 5038 proto tcp comment "nodewatch AMI" >/dev/null
    ufw reload >/dev/null
    ok "ufw: allowed port 5038 from $NW_HOST"
    FW_DONE=1
fi

if [[ $FW_DONE -eq 0 ]] && command -v firewall-cmd &>/dev/null && firewall-cmd --state &>/dev/null 2>&1; then
    firewall-cmd --permanent \
        --add-rich-rule="rule family='ipv4' source address='$NW_HOST' port port='5038' protocol='tcp' accept" \
        >/dev/null
    firewall-cmd --reload >/dev/null
    ok "firewalld: allowed port 5038 from $NW_HOST"
    FW_DONE=1
fi

if [[ $FW_DONE -eq 0 ]] && command -v iptables &>/dev/null; then
    iptables -C INPUT -s "$NW_HOST" -p tcp --dport 5038 -j ACCEPT 2>/dev/null || \
        iptables -I INPUT -s "$NW_HOST" -p tcp --dport 5038 -j ACCEPT
    command -v netfilter-persistent &>/dev/null && netfilter-persistent save >/dev/null 2>&1 || true
    command -v iptables-save &>/dev/null && iptables-save > /etc/iptables/rules.v4 2>/dev/null || true
    ok "iptables: allowed port 5038 from $NW_HOST"
    FW_DONE=1
fi

[[ $FW_DONE -eq 1 ]] || warn "No active firewall detected — ensure port 5038 is reachable from $NW_HOST"

# ── Reload Asterisk Manager ────────────────────────────────────────────────────
step "Reloading Asterisk Manager Interface..."
if command -v asterisk &>/dev/null; then
    asterisk -rx "module reload manager" >/dev/null 2>&1
    ok "Asterisk manager reloaded"
else
    warn "asterisk CLI not found — reload manually: asterisk -rx 'module reload manager'"
fi

# ── Get this node's local IP (route toward nodewatch) ─────────────────────────
LOCAL_IP=$(ip route get "$NW_HOST" 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')
ok "This node's IP toward nodewatch: $LOCAL_IP"

# ── Build JSON payload ─────────────────────────────────────────────────────────
step "Encrypting and registering with nodewatch..."
JSON=$(printf '{"token_id":"%s","nodes":[' "$TOKEN_ID"
FIRST=1
for N in "${NODES[@]}"; do
    [[ $FIRST -eq 1 ]] || printf ','
    printf '{"node":%d,"host":"%s","user":"%s","password":"%s","label":""}' \
        "$N" "$LOCAL_IP" "$AMI_USER" "$AMI_PASS"
    FIRST=0
done
printf ']}')

# ── AES-256-CBC encrypt with raw hex key+iv (no password derivation, no salt)
ENC=$(printf '%s' "$JSON" | \
    openssl enc -aes-256-cbc -K "$KEY_HEX" -iv "$IV_HEX" -nosalt -base64 -A | \
    tr -d '\n')

# ── POST encrypted payload to nodewatch ───────────────────────────────────────
HTTP_RESP=$(curl -sf --max-time 15 -X POST "$NODEWATCH_URL/api/provision/register" \
    -H "Content-Type: application/json" \
    --data-raw "{\"token_id\":\"$TOKEN_ID\",\"payload\":\"$ENC\"}" 2>&1) \
    || die "Could not reach nodewatch at $NODEWATCH_URL — check network connectivity"

echo "$HTTP_RESP" | grep -q '"ok":true' || die "nodewatch rejected the registration: $HTTP_RESP"

# ── Done ───────────────────────────────────────────────────────────────────────
echo ""
echo -e "${G}══════════════════════════════════════════${NC}"
echo -e "${G}  Remote node provisioning complete!     ${NC}"
echo -e "${G}══════════════════════════════════════════${NC}"
echo ""
echo "  Node(s) registered: ${NODES[*]}"
echo "  Host reported:      $LOCAL_IP"
echo "  AMI user:           $AMI_USER"
echo ""
echo "  Return to the nodewatch UI — the server is restarting."
echo "  The new node(s) will appear under Settings → Local Nodes."
echo ""
