#!/usr/bin/env bash
# =============================================================================
# nodewatch — AllStar Node Monitor installer
# =============================================================================
# Usage:
#   sudo bash install.sh                  # fresh install
#   sudo bash install.sh --port 9090      # fresh install on a custom port
#   sudo bash install.sh --reconfigure    # re-read Asterisk config and rewrite config.toml
#   sudo bash install.sh --update         # pull latest code, restart service
#   sudo bash install.sh --uninstall      # stop service and remove all files
# =============================================================================
set -euo pipefail

INSTALL_DIR="/opt/nodewatch"
REPO="https://github.com/dfrederick15/nodewatch.git"
SERVICE="nodewatch"
PORT=8080
RECONFIGURE=false
UPDATE_ONLY=false
UNINSTALL=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)        PORT="${2:?'--port requires a value'}"; shift 2 ;;
    --reconfigure) RECONFIGURE=true; shift ;;
    --update)      UPDATE_ONLY=true; shift ;;
    --uninstall)   UNINSTALL=true; shift ;;
    *) shift ;;
  esac
done

# ── Output helpers ────────────────────────────────────────────────────────────
G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; B='\033[1;34m'; NC='\033[0m'
info() { echo -e "${G}  ✓${NC}  $*"; }
step() { echo -e "\n${B}▶${NC}  $*"; }
warn() { echo -e "${Y}  !${NC}  $*"; }
die()  { echo -e "\n${R}  ✗  ERROR:${NC} $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run as root:  sudo bash install.sh"

# ── Uninstall path ───────────────────────────────────────────────────────────
if $UNINSTALL; then
  step "Uninstalling nodewatch..."
  if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
    systemctl stop "$SERVICE"
    info "Service stopped"
  fi
  if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
    systemctl disable "$SERVICE"
    info "Service disabled"
  fi
  SERVICE_FILE="/etc/systemd/system/${SERVICE}.service"
  if [[ -f "$SERVICE_FILE" ]]; then
    rm -f "$SERVICE_FILE"
    systemctl daemon-reload
    info "Service file removed"
  fi
  if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    info "Removed $INSTALL_DIR"
  fi
  echo ""
  echo -e "${G}  nodewatch has been uninstalled.${NC}"
  echo ""
  exit 0
fi

# ── Find a free port ──────────────────────────────────────────────────────────
REQUESTED_PORT=$PORT
while ss -tlnH "sport = :$PORT" 2>/dev/null | grep -q .; do
  PORT=$(( PORT + 1 ))
done
[[ $PORT -ne $REQUESTED_PORT ]] && warn "Port $REQUESTED_PORT is in use — using $PORT instead"

# ── Update-only path ──────────────────────────────────────────────────────────
if $UPDATE_ONLY; then
  [[ -d "$INSTALL_DIR/.git" ]] || die "$INSTALL_DIR not found. Run without --update to do a fresh install."
  step "Pulling latest code..."
  git -C "$INSTALL_DIR" pull -q
  npm --prefix "$INSTALL_DIR" install --omit=dev --silent
  systemctl restart "$SERVICE" 2>/dev/null || true
  info "Updated and restarted. Done."
  exit 0
fi

# ── 1. Node.js 22+ ────────────────────────────────────────────────────────────
step "Checking Node.js..."
NEED_NODE=true
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node -e 'process.stdout.write(process.version.replace("v","").split(".")[0])')
  (( NODE_MAJOR >= 22 )) && NEED_NODE=false && info "Node.js $(node --version) already installed"
fi

if $NEED_NODE; then
  info "Installing Node.js 22..."
  if command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    apt-get install -y nodejs >/dev/null 2>&1
  elif command -v dnf &>/dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
    dnf install -y nodejs >/dev/null 2>&1
  else
    die "Unknown package manager. Install Node.js 22+ from https://nodejs.org then re-run."
  fi
  info "Node.js $(node --version) installed"
fi

# ── 2. git ────────────────────────────────────────────────────────────────────
if ! command -v git &>/dev/null; then
  step "Installing git..."
  command -v apt-get &>/dev/null && apt-get install -y git >/dev/null 2>&1
  command -v dnf     &>/dev/null && dnf install -y git     >/dev/null 2>&1
  info "git installed"
fi

# ── 3. Clone or update repo ───────────────────────────────────────────────────
step "Installing nodewatch to $INSTALL_DIR..."
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Repository already exists — pulling latest"
  git -C "$INSTALL_DIR" pull -q
else
  info "Cloning from $REPO"
  git clone -q "$REPO" "$INSTALL_DIR"
fi
npm --prefix "$INSTALL_DIR" install --omit=dev --silent
info "Dependencies installed"

# ── 4. Read Asterisk configuration ───────────────────────────────────────────
step "Reading Asterisk configuration..."

RPT_CONF="/etc/asterisk/rpt.conf"
MGR_CONF="/etc/asterisk/manager.conf"

[[ -f "$RPT_CONF" ]] || die "$RPT_CONF not found — is AllStar/Asterisk installed?"
[[ -f "$MGR_CONF" ]] || die "$MGR_CONF not found — is AllStar/Asterisk installed?"

# Node numbers: lines like "65659 = radio@127.0.0.1/65659,NONE" inside [nodes]
mapfile -t NODE_NUMS < <(awk '
  /^\[nodes\]/ { in_sec=1; next }
  /^\[/        { in_sec=0 }
  in_sec && /^[0-9]+ *=/ { print $1 }
' "$RPT_CONF")
[[ ${#NODE_NUMS[@]} -gt 0 ]] || die "No local node numbers found in $RPT_CONF — check the [nodes] section"
info "Found node(s): ${NODE_NUMS[*]}"

# AMI user: first stanza that isn't [general] (handles tabs, spaces, CR+LF)
AMI_USER=$(awk '
  /^[[:space:]]*;/ { next }
  /^\[/ {
    name=$0; gsub(/[\[\][:space:]\r]/, "", name)
    if (name != "" && name != "general") { print name; exit }
  }
' "$MGR_CONF")
[[ -n "$AMI_USER" ]] || die "No AMI user stanza found in $MGR_CONF"

# AMI password: handles tabs/spaces around =, CR+LF line endings, and
# both 'secret' and 'password' key names
AMI_PASS=$(awk -v u="$AMI_USER" '
  /^[[:space:]]*;/ { next }
  /^\[/ { name=$0; gsub(/[\[\][:space:]\r]/, "", name); cur=name }
  cur == u && /^[[:space:]]*(secret|password)[[:space:]]*=/ {
    sub(/^[[:space:]]*(secret|password)[[:space:]]*=[[:space:]]*/, "")
    gsub(/[[:space:]\r]*$/, "")
    print; exit
  }
' "$MGR_CONF")
[[ -n "$AMI_PASS" ]] || die "No secret/password found for [$AMI_USER] in $MGR_CONF"
info "AMI credentials: user=$AMI_USER"

# Callsign: try common AllStar env files, then fall back to MYCALL
CALLSIGN="MYCALL"
for env_file in /usr/local/etc/allstar.env /etc/allstar/allstar.env /etc/asterisk/allstar.env; do
  if [[ -f "$env_file" ]]; then
    cs=$(grep -i '^CALL=' "$env_file" 2>/dev/null | head -1 | cut -d'=' -f2 | tr -d '"'"'" | tr -d ' ' || true)
    [[ -n "$cs" ]] && CALLSIGN="$cs" && break
  fi
done
# Also try rpt.conf: lines like "call = W1ABC" inside the first node stanza
if [[ "$CALLSIGN" == "MYCALL" ]]; then
  first_node="${NODE_NUMS[0]}"
  cs=$(awk -v n="[$first_node]" '
    $0==n || $0=="["n"](node-main)" { found=1; next }
    found && /^call *=/ { gsub(/ /,"",$0); sub(/^call=/,""); print; exit }
    found && /^\[/ { exit }
  ' "$RPT_CONF" | tr -d '"' | tr -d "'" || true)
  [[ -n "$cs" ]] && CALLSIGN="$cs"
fi
info "Callsign: $CALLSIGN"

# ── 5. Write config.toml ──────────────────────────────────────────────────────
CONFIG="$INSTALL_DIR/config.toml"

if [[ -f "$CONFIG" ]] && ! $RECONFIGURE; then
  warn "config.toml already exists — skipping (run with --reconfigure to overwrite)"
else
  step "Writing config.toml..."
  [[ -f "$CONFIG" ]] && cp "$CONFIG" "${CONFIG}.bak" && info "Backed up existing config to config.toml.bak"

  # Build [[nodes]] blocks for each local node
  NODES_TOML=""
  for node in "${NODE_NUMS[@]}"; do
    NODES_TOML+="
[[nodes]]
node        = $node
host        = \"127.0.0.1\"
user        = \"$AMI_USER\"
password    = \"$AMI_PASS\"
label       = \"\"
private     = false
stream_url  = \"\"
website_url = \"\"
"
  done

  cat > "$CONFIG" << TOML
# =============================================================================
# AllStar Node Monitor — Configuration
# =============================================================================
# Edit this file to match your setup, then restart: sudo systemctl restart nodewatch
# Format: TOML  https://toml.io
# =============================================================================


# -----------------------------------------------------------------------------
[server]
# -----------------------------------------------------------------------------

# Port the web UI listens on.
port = $PORT

# Bind address.
#   "0.0.0.0"   — all interfaces (accessible from the network)
#   "127.0.0.1" — localhost only
host = "0.0.0.0"

# How often (ms) to poll Asterisk for node status updates.
# Lower = more responsive. Higher = less load on Asterisk.
# Range: 500–10000
poll_interval_ms = 1000

# Seconds to wait when opening a TCP socket to Asterisk Manager.
ami_connect_timeout_s = 5

# Seconds to wait for a response after sending an AMI command.
ami_read_timeout_s = 5


# -----------------------------------------------------------------------------
[auth]
# -----------------------------------------------------------------------------
# Login credentials for the control interface.
# The UI is read-only when not logged in.

username = "admin"
password = "changeme"

# Session lifetime in seconds before auto-logout.
#   3600  = 1 hour
#   86400 = 24 hours
session_timeout_s = 3600


# -----------------------------------------------------------------------------
[display]
# -----------------------------------------------------------------------------

callsign = "$CALLSIGN"
title    = "AllStar Monitor"
location = ""

# Maximum connected nodes shown per local node. 0 = show all.
max_nodes = 0

# Show nodes that have never transmitted.
#   true | false
show_never_heard = true

# IANA timezone for timestamps.
# Examples: "America/New_York" | "America/Chicago" | "America/Los_Angeles" | "UTC"
# Full list: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
timezone = "America/New_York"


# -----------------------------------------------------------------------------
[favorites]
# -----------------------------------------------------------------------------
# Add node numbers here to track them in the Favorites tab.
# Separate multiple nodes with commas: nodes = [27339, 12345]

nodes = []


# -----------------------------------------------------------------------------
# [[nodes]] — one block per local AllStar node
# -----------------------------------------------------------------------------
# Copy this block to add more nodes.
#
# node        — AllStar node number
# host        — IP of the Asterisk server ("127.0.0.1" = this machine)
#               Append port if non-default: "192.168.1.10:5038"
# user        — Asterisk Manager username  (from /etc/asterisk/manager.conf)
# password    — Asterisk Manager password
# label       — Friendly name shown in the UI header (optional)
# private     — true = hide the AllStar stats hyperlink
#               Options: true | false
# stream_url  — URL to a live audio stream (optional)
# website_url — URL to a web page for this node (optional)
$NODES_TOML

# -----------------------------------------------------------------------------
# [[commands]] — control panel dropdown entries
# -----------------------------------------------------------------------------
# label   — text shown in the dropdown
# command — Asterisk CLI command to run
#           Use %node% as a placeholder for the local node number.
#
# Common commands:
#   rpt xnode %node%           — extended node status
#   rpt lstats %node%          — link statistics
#   rpt fun %node% *70         — disable linking
#   rpt fun %node% *71         — enable linking
#   core show version          — Asterisk version
#   core show channels         — active channels
#   dialplan reload            — reload dialplan (no restart needed)
#   module reload chan_iax2.so — reload IAX2 driver
#   module reload app_rpt.so   — reload AllStar module

[[commands]]
label   = "Node Status"
command = "rpt xnode %node%"

[[commands]]
label   = "Link Stats"
command = "rpt lstats %node%"

[[commands]]
label   = "Disable Linking"
command = "rpt fun %node% *70"

[[commands]]
label   = "Enable Linking"
command = "rpt fun %node% *71"

[[commands]]
label   = "Asterisk Version"
command = "core show version"

[[commands]]
label   = "Active Channels"
command = "core show channels"

[[commands]]
label   = "Reload Dialplan"
command = "dialplan reload"

[[commands]]
label   = "Reload IAX2"
command = "module reload chan_iax2.so"

[[commands]]
label   = "Reload app_rpt"
command = "module reload app_rpt.so"
TOML

  info "config.toml written"
fi

# ── 6. systemd service ────────────────────────────────────────────────────────
step "Setting up systemd service..."
cat > "/etc/systemd/system/${SERVICE}.service" << EOF
[Unit]
Description=AllStar Node Monitor (nodewatch)
After=network.target asterisk.service

[Service]
Type=simple
User=root
WorkingDirectory=$INSTALL_DIR
ExecStart=/usr/bin/node --experimental-strip-types server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
if systemctl is-active --quiet "$SERVICE"; then
  systemctl restart "$SERVICE"
  info "Service restarted"
else
  systemctl start "$SERVICE"
  info "Service started"
fi

# ── 7. Done ───────────────────────────────────────────────────────────────────
# Get local IP for display
LOCAL_IP=$(ip route get 1.1.1.1 2>/dev/null | grep -oP 'src \K\S+' || hostname -I | awk '{print $1}')

echo ""
echo -e "${G}═══════════════════════════════════════════${NC}"
echo -e "${G}  nodewatch is running!${NC}"
echo -e "${G}═══════════════════════════════════════════${NC}"
echo ""
echo -e "  Web UI:   ${B}http://${LOCAL_IP}:${PORT}${NC}"
echo ""
echo -e "  Config:   ${INSTALL_DIR}/config.toml"
echo -e "  Logs:     journalctl -u ${SERVICE} -f"
echo -e "  Restart:  sudo systemctl restart ${SERVICE}"
echo -e "  Update:   sudo bash install.sh --update"
echo ""
warn "Default login password is 'changeme' — update [auth] password in config.toml"
echo ""
