# nodewatch

A web-based monitor and controller for [AllStar Link](https://www.allstarlink.org/) ham radio nodes. Replaces the legacy PHP Supermon interface with a modern TypeScript/Node.js server and a clean browser UI — no build step, no database, no framework dependencies.

## Features

- Live node status via Server-Sent Events — connection list, keyed state, link direction and mode
- Ticking link-age and last-keyed counters updated client-side every second
- Subnode expansion — see what each connected node is itself linked to (via AllStar stats API)
- UTC clock synced to pool.ntp.org
- Internal and external IP display in the header
- Favorites tab — track any set of nodes at a glance
- Control panel — send Asterisk CLI commands from the browser
- Remote node auto-provisioning — generates a one-time encrypted shell command that configures a remote node's AMI, opens its firewall, and registers it with nodewatch automatically
- Two themes (Amber / Slate) switchable from the header
- Session auth via HttpOnly cookies; UI is read-only when not logged in

## Requirements

- **Node.js 22.6+** (uses `--experimental-strip-types` to run TypeScript directly — no compile step)
- **AllStar / Asterisk** with the Manager Interface (AMI) enabled on port 5038
- A Linux host (Debian/Ubuntu/RHEL — ARM64 and x86-64 tested)

## Install (recommended)

Run the installer as root on your AllStar node. It reads your existing Asterisk config, writes `config.toml`, and sets up a systemd service.

```bash
sudo bash -c "$(curl -fsSL https://raw.githubusercontent.com/dfrederick15/nodewatch/main/install.sh)"
```

Then open `http://<node-ip>:8080` in a browser.

**Install on a different port** (if 8080 is taken):

```bash
sudo bash install.sh --port 9090
```

**Update an existing install:**

```bash
sudo bash install.sh --update
```

**Re-read Asterisk config and rewrite config.toml:**

```bash
sudo bash install.sh --reconfigure
```

## Manual install

```bash
git clone https://github.com/dfrederick15/nodewatch.git /opt/nodewatch
cd /opt/nodewatch
npm install --omit=dev
cp config.toml.example config.toml   # edit to match your setup
npm start
```

## Configuration

All settings live in `config.toml`. The installer writes this file automatically. Edit it and restart the service to apply changes.

```toml
[server]
port             = 8080
host             = "0.0.0.0"
poll_interval_ms = 1000        # how often to poll Asterisk (ms)
ami_connect_timeout_s = 5
ami_read_timeout_s    = 5

[auth]
username         = "admin"
password         = "changeme"  # change this
session_timeout_s = 3600

[display]
callsign         = "W1ABC"
title            = "AllStar Monitor"
timezone         = "America/New_York"
max_nodes        = 0           # 0 = show all connections
show_never_heard = true

[[nodes]]
node     = 65659
host     = "127.0.0.1"        # IP of Asterisk; append :port if non-default
user     = "admin"             # AMI username from manager.conf
password = "secret"
label    = ""

[[commands]]
label   = "Node Status"
command = "rpt xnode %node%"   # %node% is replaced with the local node number
```

## Service management

```bash
sudo systemctl status nodewatch
sudo systemctl restart nodewatch
sudo journalctl -u nodewatch -f   # live logs
```

## Remote node provisioning

In Settings → Local Nodes, click **Generate Provision Command**. Paste the generated command on the remote node as root. It will:

1. Add a dedicated `nodewatch` AMI user to `/etc/asterisk/manager.conf`
2. Open port 5038 in the remote node's firewall (ufw / firewalld / iptables)
3. Reload the Asterisk Manager
4. Encrypt the credentials with a one-time AES-256 key and POST them to nodewatch
5. nodewatch saves the node and restarts

The token expires in 10 minutes and is single-use.

## Development

```bash
npm run dev   # starts server with --watch (auto-restarts on file changes)
```

No build step — Node.js strips TypeScript types at runtime via `--experimental-strip-types`.

## License

MIT
