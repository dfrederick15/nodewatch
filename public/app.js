/**
 * app.js — AllStar Monitor client
 *
 * No external dependencies. Runs in any modern browser.
 *
 * Tabs:
 *  Home      — Live node status panels from SSE; connect/disconnect controls.
 *  Favorites — Polls /api/favorites/status every 30 s; shows network-wide status
 *              for saved nodes. Add/remove nodes (auth required).
 *  Settings  — Full config.toml editor. Saves to server and triggers a restart.
 */

// ── State ─────────────────────────────────────────────────────────────────────

let config = null;       // from /api/config
let loggedIn = false;
let currentTab = "home";

// Live counter state per local node: nodeNum → [{node,elapsed,last_keyed,receivedAt}]
const liveTimes = {};

// Expanded subnode rows: "localNode-remoteNode"
const expandedRows = new Set();

// ── Boot ──────────────────────────────────────────────────────────────────────

// ── Theme ─────────────────────────────────────────────────────────────────────

const THEMES = [
  { id: "amber", file: "theme-amber.css", label: "Amber — warm near-black with gold accents" },
  { id: "slate", file: "theme-slate.css", label: "Slate — cool blue-gray dark theme" },
];

function applyTheme(id) {
  const theme = THEMES.find(t => t.id === id) ?? THEMES[0];
  document.getElementById("theme-css").href = theme.file;
  localStorage.setItem("nodewatch-theme", theme.id);
  const sel = document.getElementById("theme-select");
  if (sel) sel.value = theme.id;
}

function initTheme() {
  const saved = localStorage.getItem("nodewatch-theme") ?? "amber";
  const sel = document.getElementById("theme-select");
  if (sel && sel.options.length === 0) {
    THEMES.forEach(t => {
      const opt = document.createElement("option");
      opt.value = t.id;
      opt.textContent = t.id.charAt(0).toUpperCase() + t.id.slice(1);
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => applyTheme(sel.value));
  }
  applyTheme(saved);
}

async function boot() {
  initTheme();
  await loadConfig();
  await checkSession();
  await initClock();
  loadNetworkInfo();   // fire-and-forget; fills header IPs when ready
  connectSSE();
  startLiveTimer();
  wireButtons();
  wireLoginDialog();
  wireTabs();
}

async function loadNetworkInfo() {
  try {
    const res = await fetch("/api/network");
    if (!res.ok) return;
    const d = await res.json();
    const el = document.getElementById("hdr-ips");
    if (!el) return;
    const rows = [];
    if (d.internal)      rows.push(`<span class="hdr-ip-row"><span class="hdr-ip-label">INT</span><span class="hdr-ip-val">${escHtml(d.internal)}</span></span>`);
    if (d.external_ipv4) rows.push(`<span class="hdr-ip-row"><span class="hdr-ip-label">EXT4</span><span class="hdr-ip-val">${escHtml(d.external_ipv4)}</span></span>`);
    if (d.external_ipv6) rows.push(`<span class="hdr-ip-row"><span class="hdr-ip-label">EXT6</span><span class="hdr-ip-val">${escHtml(d.external_ipv6)}</span></span>`);
    el.innerHTML = rows.join("");
  } catch (_) {}
}

async function loadConfig() {
  const res = await fetch("/api/config");
  config = await res.json();

  document.getElementById("hdr-callsign").textContent = config.display.callsign;
  document.getElementById("hdr-subtitle").textContent = config.display.title;
  document.title = config.display.title;

  const sel = document.getElementById("local-node");
  sel.innerHTML = "";
  for (const n of config.nodes) {
    const opt = document.createElement("option");
    opt.value = String(n.node);
    opt.textContent = n.label ? `${n.node} — ${n.label}` : String(n.node);
    sel.appendChild(opt);
  }

  const cmdSel = document.getElementById("cmd-select");
  cmdSel.innerHTML = "";
  for (const cmd of config.commands) {
    const opt = document.createElement("option");
    opt.value = cmd.command;
    opt.textContent = cmd.label;
    cmdSel.appendChild(opt);
  }

  const area = document.getElementById("nodes-area");
  area.innerHTML = "";
  for (const n of config.nodes) area.appendChild(buildNodePanel(n));
}

async function checkSession() {
  const res = await fetch("/api/session");
  const data = await res.json();
  setLoggedIn(data.logged_in, data.username);
}

// ── NTP clock ─────────────────────────────────────────────────────────────────
// Fetch the server's NTP-corrected time once, calculate the offset from our
// local clock, then tick the display every second using that offset so the
// clock stays accurate without hitting the server on every tick.

let clockOffsetMs = 0;

async function initClock() {
  try {
    const t0   = Date.now();
    const data = await fetch("/api/time").then(r => r.json());
    const t1   = Date.now();
    // Correct for one-way network latency (assume symmetric)
    clockOffsetMs = data.unix_ms - Math.round((t0 + t1) / 2);
    const el = document.getElementById("clock-area");
    if (el && data.ntp_server) el.title = `UTC from ${data.ntp_server} · offset ${data.offset_ms >= 0 ? "+" : ""}${data.offset_ms} ms`;
  } catch (_) {
    // If the endpoint fails, clockOffsetMs stays 0 and we show the browser clock
  }
  tickClock();
  setInterval(tickClock, 1000);
}

function tickClock() {
  const now = new Date(Date.now() + clockOffsetMs);
  const hh  = String(now.getUTCHours()).padStart(2, "0");
  const mm  = String(now.getUTCMinutes()).padStart(2, "0");
  const ss  = String(now.getUTCSeconds()).padStart(2, "0");
  const el  = document.getElementById("clock");
  if (el) el.textContent = `${hh}:${mm}:${ss}`;
}

// ── Tab routing ───────────────────────────────────────────────────────────────

function wireTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });
}

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll(".tab-btn").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach(p =>
    p.classList.toggle("active", p.id === `tab-${name}`));

  const wide = name !== "home";
  document.getElementById("main-layout").classList.toggle("wide", wide);

  if (name === "favorites") loadFavorites();
  if (name === "settings")  loadSettings();
}

// ── SSE (Home tab) ────────────────────────────────────────────────────────────

let sseSource = null;
let sseErrorTimer = null;
const spinChars = ["|", "/", "-", "\\"];
let spinIdx = 0;

function connectSSE() {
  if (sseSource) sseSource.close();
  clearTimeout(sseErrorTimer);
  const nodeNums = config.nodes.map(n => n.node).join(",");
  sseSource = new EventSource(`/api/sse?nodes=${nodeNums}`);

  sseSource.addEventListener("node_status", (e) => {
    clearTimeout(sseErrorTimer);
    renderNodeTable(JSON.parse(e.data));
    setStatusDot("connected");
    tick();
  });

  sseSource.addEventListener("node_times", (e) => {
    clearTimeout(sseErrorTimer);
    const data = JSON.parse(e.data);
    liveTimes[data.node] = (data.connections ?? []).map(c => ({
      node:        c.node,
      elapsed:     c.elapsed,
      last_keyed:  c.last_keyed,
      receivedAt:  Date.now(),
    }));
    tick();
  });

  sseSource.addEventListener("node_error", (e) => {
    const data = JSON.parse(e.data);
    showNodeError(data.node, data.error);
    setStatusDot("error");
  });

  // Debounce: don't show "No Signal" for transient disconnects (e.g., page refresh
  // creates a new EventSource before the old one fully closes on the server side).
  sseSource.onerror = () => {
    clearTimeout(sseErrorTimer);
    sseErrorTimer = setTimeout(() => setStatusDot("error"), 2500);
  };
}

function tick() {
  document.getElementById("spinner").textContent = spinChars[spinIdx++ % spinChars.length];
}

// ── Live counter timer ────────────────────────────────────────────────────────

function startLiveTimer() {
  setInterval(() => {
    const now = Date.now();
    for (const [nodeNum, conns] of Object.entries(liveTimes)) {
      conns.forEach((c) => {
        const delta = Math.floor((now - c.receivedAt) / 1000);
        const lk    = c.last_keyed === -1 ? -1 : c.last_keyed + delta;
        const el    = c.elapsed + delta;
        const lkEl  = document.getElementById(`lkey-${nodeNum}-${c.node}`);
        const elEl  = document.getElementById(`elap-${nodeNum}-${c.node}`);
        if (lkEl) lkEl.textContent = formatLastKeyed(lk);
        if (elEl) elEl.textContent = formatElapsed(el);
      });
    }
  }, 1000);
}

// ── Home tab: node panel rendering ───────────────────────────────────────────

function buildNodePanel(nodeCfg) {
  const panel = document.createElement("div");
  panel.className = "node-panel";
  panel.id = `panel-${nodeCfg.node}`;
  panel.innerHTML = `
    <div class="node-panel-header">
      <span class="node-num">${nodeCfg.node}</span>
      <span class="node-label">${nodeCfg.label ?? ""}</span>
      <span class="state-badge idle" id="badge-${nodeCfg.node}">Idle</span>
    </div>
    <div id="table-wrap-${nodeCfg.node}">
      <div class="no-connections">Waiting for data…</div>
    </div>`;
  return panel;
}

function renderNodeTable(status) {
  const { node: nodeNum } = status;
  const wrap = document.getElementById(`table-wrap-${nodeNum}`);
  if (!wrap) return;

  const { cos_keyed, tx_keyed } = status;

  // Reflect active state on the panel element so CSS can color the header
  const panel = document.getElementById(`panel-${nodeNum}`);
  if (panel) {
    panel.dataset.state = cos_keyed && tx_keyed ? "fullduplex"
      : cos_keyed ? "cos" : tx_keyed ? "ptt" : "idle";
  }

  const badge = document.getElementById(`badge-${nodeNum}`);
  if (badge) {
    if (cos_keyed && tx_keyed) {
      badge.className = "state-badge fullduplex"; badge.textContent = "Full Duplex";
    } else if (cos_keyed) {
      badge.className = "state-badge cos";        badge.textContent = "Carrier Detected";
    } else if (tx_keyed) {
      badge.className = "state-badge ptt";        badge.textContent = "Transmitting";
    } else {
      badge.className = "state-badge idle";       badge.textContent = "Idle";
    }
  }

  let conns = status.connections.filter(c => c.node !== "1");
  if (!config.display.show_never_heard) conns = conns.filter(c => c.last_keyed !== -1);
  if (config.display.max_nodes > 0) conns = conns.slice(0, config.display.max_nodes);
  conns.sort((a, b) => {
    if (a.last_keyed === -1 && b.last_keyed === -1) return 0;
    if (a.last_keyed === -1) return 1;
    if (b.last_keyed === -1) return -1;
    return a.last_keyed - b.last_keyed;
  });

  if (conns.length === 0) {
    wrap.innerHTML = `<div class="no-connections">No connections.</div>`;
    return;
  }

  let html = `
    <table class="node-table">
      <thead>
        <tr>
          <th style="width:26px"></th>
          <th>Node #</th>
          <th>Station / Location</th>
          <th>Last Keyed</th>
          <th>Link Type</th>
          <th>Direction</th>
          <th>Link Age</th>
          <th>Mode</th>
        </tr>
      </thead><tbody>`;

  for (let i = 0; i < conns.length; i++) {
    const c = conns[i];
    const rowKey = `${nodeNum}-${c.node}`;
    const hasSubnodes = Array.isArray(c.subnodes) && c.subnodes.length > 0;
    const isExpanded  = expandedRows.has(rowKey);
    const rowClass    = c.keyed ? "keyed" : c.link === "CONNECTING" ? "connecting" : "";

    html += `<tr class="${rowClass}" data-node="${escAttr(c.node)}" data-local="${escAttr(nodeNum)}">
      <td class="expand-cell">
        ${hasSubnodes
          ? `<button class="expand-btn" data-key="${escAttr(rowKey)}">${isExpanded ? "▼" : "▶"}</button>`
          : ""}
      </td>
      <td class="node-col">${escHtml(c.node)}</td>
      <td class="info-col">${escHtml(c.info || c.ip || "")}</td>
      <td class="muted-col" id="lkey-${nodeNum}-${c.node}">${formatLastKeyed(c.last_keyed)}</td>
      <td class="muted-col">${escHtml(c.link)}</td>
      <td class="muted-col">${escHtml(c.direction)}</td>
      <td class="muted-col" id="elap-${nodeNum}-${c.node}">${formatElapsed(c.elapsed)}</td>
      <td class="muted-col">${modeLabel(c.mode)}</td>
    </tr>`;

    if (hasSubnodes) {
      for (const sub of c.subnodes) {
        html += `<tr class="subnode-row${isExpanded ? "" : " subnode-hidden"}" data-parent="${escAttr(rowKey)}">
          <td></td>
          <td class="node-col subnode-node">↳ ${escHtml(sub.node)}</td>
          <td class="info-col" colspan="6">${escHtml(sub.info || "")}</td>
        </tr>`;
      }
    }
  }

  html += `</tbody></table>`;
  wrap.innerHTML = html;

  wrap.querySelectorAll("tr[data-node]").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".expand-btn")) return;
      document.getElementById("remote-input").value = row.dataset.node;
      document.getElementById("local-node").value   = row.dataset.local;
    });
  });

  wrap.querySelectorAll(".expand-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.key;
      if (expandedRows.has(key)) { expandedRows.delete(key); btn.textContent = "▶"; }
      else                        { expandedRows.add(key);    btn.textContent = "▼"; }
      wrap.querySelectorAll(`.subnode-row[data-parent="${CSS.escape(key)}"]`).forEach(row =>
        row.classList.toggle("subnode-hidden"));
    });
  });
}

function showNodeError(nodeNum, msg) {
  const wrap = document.getElementById(`table-wrap-${nodeNum}`);
  if (wrap) wrap.innerHTML = `<div class="no-connections" style="color:var(--red)">${escHtml(msg)}</div>`;
}

// ── Favorites tab ─────────────────────────────────────────────────────────────

let favPollTimer = null;

async function loadFavorites() {
  const area = document.getElementById("favorites-area");
  area.innerHTML = `<div class="fav-toolbar">
    <h2>Favorite Nodes</h2>
    ${loggedIn ? `<div class="fav-add-row">
      <input type="text" id="fav-add-input" placeholder="Node number" style="width:120px">
      <button id="fav-add-btn" class="primary">+ Add</button>
    </div>` : ""}
    <button id="fav-refresh-btn">↻ Refresh</button>
  </div>
  <div id="fav-status-msg" style="color:var(--muted);font-size:12px;padding-bottom:4px"></div>
  <div id="fav-table-wrap"></div>`;

  document.getElementById("fav-refresh-btn").addEventListener("click", pollFavorites);
  if (loggedIn) {
    document.getElementById("fav-add-btn").addEventListener("click", addFavorite);
    document.getElementById("fav-add-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") addFavorite();
    });
  }

  await pollFavorites();

  // Refresh every 30 s while on this tab
  clearInterval(favPollTimer);
  favPollTimer = setInterval(() => {
    if (currentTab === "favorites") pollFavorites();
  }, 30_000);
}

async function pollFavorites() {
  const msg = document.getElementById("fav-status-msg");
  if (msg) msg.textContent = "Refreshing…";
  try {
    const res = await fetch("/api/favorites/status");
    const rows = await res.json();
    if (msg) msg.textContent = `Updated ${new Date().toLocaleTimeString()}`;
    renderFavoritesTable(rows);
  } catch (_) {
    if (msg) msg.textContent = "Could not reach server.";
  }
}

function renderFavoritesTable(rows) {
  const wrap = document.getElementById("fav-table-wrap");
  if (!wrap) return;

  if (!rows || rows.length === 0) {
    wrap.innerHTML = `<div class="no-connections" style="padding:24px">
      No favorite nodes yet. ${loggedIn ? "Use the Add field above to add node numbers." : "Log in to add nodes."}
    </div>`;
    return;
  }

  let html = `<table class="fav-table">
    <thead><tr>
      <th>Node</th><th>Info</th><th>Status</th>
      <th>Connections</th><th>Connected To</th>
      ${loggedIn ? "<th></th>" : ""}
    </tr></thead><tbody>`;

  for (const r of rows) {
    const statusClass = r.keyed ? "keyed" : r.status;
    const statusLabel = r.keyed ? "Keyed" : r.status === "online" ? "Online" : "Offline";
    const chips = (r.connections ?? []).map(c =>
      `<span class="fav-conn-chip"><span>${escHtml(c.node)}</span>${c.info ? " " + escHtml(c.info) : ""}</span>`
    ).join("");

    html += `<tr>
      <td class="node-col">${escHtml(r.node)}</td>
      <td class="info-col">${escHtml(r.info || "")}</td>
      <td><span class="fav-status ${statusClass}">${statusLabel}</span></td>
      <td class="muted-col">${r.connection_count}</td>
      <td><div class="fav-conn-list">${chips || '<span class="fav-conns">—</span>'}</div></td>
      ${loggedIn ? `<td><button class="danger fav-remove-btn" data-node="${escAttr(r.node)}" style="padding:3px 8px;font-size:11px">Remove</button></td>` : ""}
    </tr>`;
  }

  html += `</tbody></table>`;
  wrap.innerHTML = html;

  if (loggedIn) {
    wrap.querySelectorAll(".fav-remove-btn").forEach(btn => {
      btn.addEventListener("click", () => removeFavorite(btn.dataset.node));
    });
  }
}

async function addFavorite() {
  const input = document.getElementById("fav-add-input");
  const node  = parseInt(input.value.trim());
  if (isNaN(node)) return;
  input.value = "";
  await apiPost("/api/favorites/add", { node });
  await pollFavorites();
}

async function removeFavorite(node) {
  await apiPost("/api/favorites/remove", { node: parseInt(node) });
  await pollFavorites();
}

// ── Settings tab ──────────────────────────────────────────────────────────────

async function loadSettings() {
  const area = document.getElementById("settings-area");
  if (!loggedIn) {
    area.innerHTML = `<div style="padding:24px;color:var(--muted);font-size:13px">Log in to access settings.</div>`;
    return;
  }

  area.innerHTML = `<div style="padding:24px;color:var(--muted);font-size:13px">Loading…</div>`;
  try {
    const res = await fetch("/api/settings");
    if (!res.ok) { area.innerHTML = `<div style="padding:24px;color:var(--red)">Failed to load settings.</div>`; return; }
    const cfg = await res.json();
    renderSettings(cfg, area);
  } catch (_) {
    area.innerHTML = `<div style="padding:24px;color:var(--red)">Could not reach server.</div>`;
  }
}

function renderSettings(cfg, area) {
  const wrap = document.createElement("div");
  wrap.className = "settings-wrap";

  // ── Top bar ────────────────────────────────────────────────────────────────
  const topbar = document.createElement("div");
  topbar.className = "settings-topbar";
  topbar.innerHTML = `
    <h2>Settings</h2>
    <span id="s-save-msg"></span>
    <button id="s-save-btn" class="primary">Save &amp; Apply</button>`;
  wrap.appendChild(topbar);

  // ── Display ────────────────────────────────────────────────────────────────
  wrap.appendChild(settingsSection("Display", true, `
    <div class="settings-grid">
      <label>Callsign</label>
      <input id="s-callsign" type="text" value="${escAttr(cfg.display.callsign)}">
      <label>Page Title</label>
      <input id="s-title" type="text" value="${escAttr(cfg.display.title)}">
      <label>Location</label>
      <input id="s-location" type="text" value="${escAttr(cfg.display.location ?? '')}">
      <label>Timezone</label>
      <input id="s-tz" type="text" value="${escAttr(cfg.display.timezone ?? 'America/New_York')}">
      <div class="settings-hint">IANA zone, e.g. America/Chicago · America/Los_Angeles · UTC</div>
      <label>Max nodes <span style="font-size:10px">(0 = all)</span></label>
      <input id="s-maxnodes" type="number" min="0" value="${cfg.display.max_nodes ?? 0}">
      <label>Show "Never Heard"</label>
      <input id="s-shownever" type="checkbox" ${cfg.display.show_never_heard ? "checked" : ""}>
    </div>`));

  // ── Authentication ─────────────────────────────────────────────────────────
  wrap.appendChild(settingsSection("Authentication", false, `
    <div class="settings-grid">
      <label>Username</label>
      <input id="s-auth-user" type="text" value="${escAttr(cfg.auth.username)}">
      <label>Password</label>
      <input id="s-auth-pass" type="password" value="${escAttr(cfg.auth.password)}">
      <label>Session timeout (seconds)</label>
      <input id="s-session-timeout" type="number" min="60" value="${cfg.auth.session_timeout_s}">
    </div>`));

  // ── Local Nodes ────────────────────────────────────────────────────────────
  const nodesBody = document.createElement("div");
  const nodesSection = settingsSection("Local Nodes", false, "");
  const nodesSectionBody = nodesSection.querySelector(".settings-section-body");

  // Provision panel — auto-configure a remote AllStar node
  const provPanel = document.createElement("div");
  provPanel.className = "s-provision-panel";
  provPanel.innerHTML = `
    <div class="s-provision-header">Auto-Provision a Remote Node</div>
    <p class="s-provision-desc">
      Generate a one-time command to run on a remote AllStar server (via SSH).
      It will configure the Asterisk Manager Interface, update the firewall, and
      securely register the node here — no manual credential entry needed.
    </p>
    <button id="s-gen-prov-btn" class="primary" style="margin-bottom:8px">Generate Provision Command</button>
    <div id="s-prov-result" style="display:none;margin-top:8px">
      <div class="s-prov-cmd-label">Paste and run this command on the remote node (as root):</div>
      <div class="s-prov-cmd-wrap">
        <textarea id="s-prov-cmd" readonly rows="5" spellcheck="false"></textarea>
        <button id="s-prov-copy-btn" style="margin-top:4px">Copy Command</button>
      </div>
      <div id="s-prov-expiry" class="s-provision-expiry"></div>
    </div>
    <div id="s-prov-msg" class="s-provision-msg"></div>`;
  nodesSectionBody.appendChild(provPanel);
  provPanel.querySelector("#s-gen-prov-btn").addEventListener("click", () => generateProvisionCommand(provPanel));

  nodesSectionBody.appendChild(nodesBody);
  renderSettingsNodes(nodesBody, cfg.nodes ?? []);
  const addNodeBtn = document.createElement("button");
  addNodeBtn.textContent = "+ Add Node Manually";
  addNodeBtn.style.marginTop = "8px";
  addNodeBtn.addEventListener("click", () => {
    const blankNode = { node: 0, host: "127.0.0.1", user: "admin", password: "", label: "", private: false, stream_url: "", website_url: "" };
    nodesBody.appendChild(buildNodeCard(blankNode));
  });
  nodesSectionBody.appendChild(addNodeBtn);
  wrap.appendChild(nodesSection);

  // ── Commands ───────────────────────────────────────────────────────────────
  const cmdsBody = document.createElement("div");
  const cmdsSection = settingsSection("Commands", false, "");
  cmdsSection.querySelector(".settings-section-body").appendChild(cmdsBody);
  renderSettingsCommands(cmdsBody, cfg.commands ?? []);
  const addCmdBtn = document.createElement("button");
  addCmdBtn.textContent = "+ Add Command";
  addCmdBtn.style.marginTop = "8px";
  addCmdBtn.addEventListener("click", () => cmdsBody.appendChild(buildCommandRow({ label: "", command: "" })));
  cmdsSection.querySelector(".settings-section-body").appendChild(addCmdBtn);
  wrap.appendChild(cmdsSection);

  // ── Server (Advanced) ──────────────────────────────────────────────────────
  wrap.appendChild(settingsSection("Server (Advanced)", false, `
    <div class="settings-grid">
      <label>Port</label>
      <input id="s-port" type="number" min="1" max="65535" value="${cfg.server.port}">
      <div class="settings-hint">Changing the port requires a browser reload to the new address after save.</div>
      <label>Bind host</label>
      <input id="s-host" type="text" value="${escAttr(cfg.server.host)}">
      <div class="settings-hint">0.0.0.0 = all interfaces &nbsp;·&nbsp; 127.0.0.1 = local only</div>
      <label>Poll interval (ms)</label>
      <input id="s-poll" type="number" min="500" value="${cfg.server.poll_interval_ms}">
      <label>AMI connect timeout (s)</label>
      <input id="s-ami-connect" type="number" min="1" value="${cfg.server.ami_connect_timeout_s}">
      <label>AMI read timeout (s)</label>
      <input id="s-ami-read" type="number" min="1" value="${cfg.server.ami_read_timeout_s}">
    </div>`));

  area.innerHTML = "";
  area.appendChild(wrap);

  // Wire collapsible sections
  wrap.querySelectorAll(".settings-section-header").forEach(hdr => {
    hdr.addEventListener("click", () => {
      const body = hdr.nextElementSibling;
      body.classList.toggle("collapsed");
      hdr.querySelector(".toggle-icon").textContent = body.classList.contains("collapsed") ? "▶" : "▼";
    });
  });

  document.getElementById("s-save-btn").addEventListener("click", () => saveSettings(cfg));
}

function settingsSection(title, expanded, bodyHtml) {
  const section = document.createElement("div");
  section.className = "settings-section";
  section.innerHTML = `
    <div class="settings-section-header">
      ${escHtml(title)}
      <span class="toggle-icon">${expanded ? "▼" : "▶"}</span>
    </div>
    <div class="settings-section-body${expanded ? "" : " collapsed"}">${bodyHtml}</div>`;
  return section;
}

function renderSettingsNodes(container, nodes) {
  container.innerHTML = "";
  nodes.forEach(n => container.appendChild(buildNodeCard(n)));
}

function buildNodeCard(n) {
  const card = document.createElement("div");
  card.className = "s-node-card";
  card.innerHTML = `
    <div class="s-node-card-header">
      <span class="s-node-card-title">Node ${n.node || "New"}</span>
      <span class="spacer"></span>
      <button class="danger s-remove-node" style="padding:3px 8px;font-size:11px">Remove</button>
    </div>
    <div class="settings-grid">
      <label>Node Number</label>
      <input class="s-node-num" type="number" value="${n.node || ""}">
      <label>Host</label>
      <input class="s-node-host" type="text" value="${escAttr(n.host || "127.0.0.1")}">
      <div class="settings-hint">IP of the Asterisk server. Custom port: 192.168.1.10:5038</div>
      <label>AMI Username</label>
      <input class="s-node-user" type="text" value="${escAttr(n.user || "")}">
      <label>AMI Password</label>
      <input class="s-node-pass" type="password" value="${escAttr(n.password || "")}">
      <label>Label <span style="font-size:10px">(optional)</span></label>
      <input class="s-node-label" type="text" value="${escAttr(n.label || "")}">
      <label>Private</label>
      <input class="s-node-private" type="checkbox" ${n.private ? "checked" : ""}>
      <label>Stream URL <span style="font-size:10px">(optional)</span></label>
      <input class="s-node-stream" type="text" value="${escAttr(n.stream_url || "")}">
      <label>Website URL <span style="font-size:10px">(optional)</span></label>
      <input class="s-node-website" type="text" value="${escAttr(n.website_url || "")}">
    </div>`;

  card.querySelector(".s-remove-node").addEventListener("click", () => card.remove());
  card.querySelector(".s-node-num").addEventListener("input", (e) => {
    card.querySelector(".s-node-card-title").textContent = `Node ${e.target.value || "New"}`;
  });
  return card;
}

function renderSettingsCommands(container, commands) {
  container.innerHTML = "";
  commands.forEach(cmd => container.appendChild(buildCommandRow(cmd)));
}

function buildCommandRow(cmd) {
  const row = document.createElement("div");
  row.className = "s-cmd-row";
  row.innerHTML = `
    <input type="text" class="s-cmd-label" placeholder="Label" value="${escAttr(cmd.label)}">
    <input type="text" class="s-cmd-command" placeholder="command (use %node% for node number)" value="${escAttr(cmd.command)}">
    <button class="danger s-remove-cmd" style="padding:4px 8px">×</button>`;
  row.querySelector(".s-remove-cmd").addEventListener("click", () => row.remove());
  return row;
}

async function saveSettings(originalCfg) {
  const msg = document.getElementById("s-save-msg");
  if (!msg) { console.error("saveSettings: #s-save-msg not found"); return; }
  const setMsg = (text, cls) => { msg.textContent = text; msg.className = cls; };
  try { await _saveSettingsInner(originalCfg, setMsg); }
  catch (err) { setMsg(`Error: ${err.message}`, "error"); }
}

async function _saveSettingsInner(originalCfg, setMsg) {

  // Collect nodes
  const nodes = [];
  document.querySelectorAll(".s-node-card").forEach(card => {
    const num = parseInt(card.querySelector(".s-node-num").value);
    if (isNaN(num)) return;
    nodes.push({
      node:        num,
      host:        card.querySelector(".s-node-host").value.trim(),
      user:        card.querySelector(".s-node-user").value.trim(),
      password:    card.querySelector(".s-node-pass").value,
      label:       card.querySelector(".s-node-label").value.trim(),
      private:     card.querySelector(".s-node-private").checked,
      stream_url:  card.querySelector(".s-node-stream").value.trim(),
      website_url: card.querySelector(".s-node-website").value.trim(),
    });
  });
  if (nodes.length === 0) { setMsg("At least one node is required.", "error"); return; }

  // Collect commands
  const commands = [];
  document.querySelectorAll(".s-cmd-row").forEach(row => {
    const label   = row.querySelector(".s-cmd-label").value.trim();
    const command = row.querySelector(".s-cmd-command").value.trim();
    if (label && command) commands.push({ label, command });
  });

  const newCfg = {
    server: {
      port:                  parseInt(document.getElementById("s-port").value)        || originalCfg.server.port,
      host:                  document.getElementById("s-host").value.trim()           || originalCfg.server.host,
      poll_interval_ms:      parseInt(document.getElementById("s-poll").value)        || originalCfg.server.poll_interval_ms,
      ami_connect_timeout_s: parseInt(document.getElementById("s-ami-connect").value) || originalCfg.server.ami_connect_timeout_s,
      ami_read_timeout_s:    parseInt(document.getElementById("s-ami-read").value)    || originalCfg.server.ami_read_timeout_s,
    },
    auth: {
      username:          document.getElementById("s-auth-user").value.trim(),
      password:          document.getElementById("s-auth-pass").value,
      session_timeout_s: parseInt(document.getElementById("s-session-timeout").value) || 3600,
    },
    display: {
      callsign:         document.getElementById("s-callsign").value.trim(),
      title:            document.getElementById("s-title").value.trim(),
      location:         document.getElementById("s-location").value.trim(),
      timezone:         document.getElementById("s-tz").value.trim() || "America/New_York",
      max_nodes:        parseInt(document.getElementById("s-maxnodes").value) || 0,
      show_never_heard: document.getElementById("s-shownever").checked,
    },
    favorites: originalCfg.favorites ?? { nodes: [] },
    nodes,
    commands,
  };

  setMsg("Saving…", "info");
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newCfg),
    });
    const data = await res.json();
    if (!data.ok) { setMsg(data.error || "Save failed.", "error"); return; }

    setMsg("Saved. Server restarting…", "ok");
    // Poll until the server is back up, then reload
    setTimeout(async () => {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        try {
          const check = await fetch("/api/session");
          if (check.ok) { window.location.reload(); return; }
        } catch (_) {}
      }
      setMsg("Server did not respond — check: journalctl -u nodewatch", "error");
    }, 800);
  } catch (_) {
    setMsg("Network error — could not reach server.", "error");
  }
}

// ── Remote node provision ─────────────────────────────────────────────────────

async function generateProvisionCommand(panel) {
  const msg     = panel.querySelector("#s-prov-msg");
  const btn     = panel.querySelector("#s-gen-prov-btn");
  const result  = panel.querySelector("#s-prov-result");
  const textarea = panel.querySelector("#s-prov-cmd");
  const copyBtn = panel.querySelector("#s-prov-copy-btn");
  const expiry  = panel.querySelector("#s-prov-expiry");

  msg.textContent = "";
  btn.disabled = true;
  btn.textContent = "Generating…";

  try {
    const res = await fetch("/api/provision/token");
    if (!res.ok) { msg.textContent = "Failed to get token — are you logged in?"; btn.disabled = false; btn.textContent = "Generate Provision Command"; return; }
    const d = await res.json();

    const cmd =
      `sudo env \\\n` +
      `  NODEWATCH_URL='${d.server_url}' \\\n` +
      `  TOKEN_ID='${d.token_id}' \\\n` +
      `  KEY_HEX='${d.key_hex}' \\\n` +
      `  IV_HEX='${d.iv_hex}' \\\n` +
      `  bash <(curl -sfL '${d.server_url}/api/provision/script')`;

    textarea.value = cmd;
    result.style.display = "block";
    btn.textContent = "Regenerate";
    btn.disabled = false;

    copyBtn.onclick = () => {
      navigator.clipboard.writeText(cmd).then(() => {
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy Command"; }, 2000);
      }).catch(() => {
        textarea.select(); document.execCommand("copy");
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy Command"; }, 2000);
      });
    };

    // Countdown
    let remaining = d.expires_in ?? 600;
    let countdownTimer = null;
    const tick = () => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(countdownTimer);
        expiry.textContent = "Expired. Click Regenerate for a new command.";
        expiry.style.color = "var(--red)";
        result.style.display = "none";
        return;
      }
      const m = Math.floor(remaining / 60);
      const s = remaining % 60;
      expiry.textContent = `Token expires in ${m}:${String(s).padStart(2, "0")} — use it before it expires`;
      expiry.style.color = "";
    };
    tick();
    countdownTimer = setInterval(tick, 1000);

  } catch (err) {
    msg.textContent = `Error: ${err.message}`;
    btn.disabled = false;
    btn.textContent = "Generate Provision Command";
  }
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function setLoggedIn(yes, username) {
  loggedIn = yes;
  document.getElementById("auth-label").textContent = yes ? String(username) : "Not logged in";
  document.getElementById("btn-login").style.display  = yes ? "none" : "";
  document.getElementById("btn-logout").style.display = yes ? "" : "none";
  document.getElementById("link-controls").style.display  = yes ? "" : "none";
  document.getElementById("cmd-controls").style.display   = yes ? "" : "none";
  document.getElementById("control-panel").style.display  = yes ? "" : "none";
}

function setStatusDot(state) {
  document.getElementById("status-dot").className =
    state === "connected" ? "connected" : state === "error" ? "error" : "";
  const txt = document.getElementById("status-text");
  if (txt) txt.textContent =
    state === "connected" ? "Connected" : state === "error" ? "No Signal" : "Connecting…";
}

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

function showResult(text, isError = false) {
  const box = document.getElementById("result-box");
  box.textContent = text;
  box.className = isError ? "error" : "";
}

function getLocalNode() { return document.getElementById("local-node").value; }
function getRemote()    { return document.getElementById("remote-input").value.trim(); }
function isPerm()       { return document.getElementById("perm-check").checked; }

// ── Home tab button wiring ────────────────────────────────────────────────────

function wireButtons() {
  for (const [id, mode] of [
    ["btn-connect",  "connect"],
    ["btn-monitor",  "monitor"],
    ["btn-localmon", "localmonitor"],
  ]) {
    document.getElementById(id)?.addEventListener("click", async () => {
      const remote = getRemote();
      if (!remote) { showResult("Enter a remote node number first.", true); return; }
      showResult(`Sending ${mode}…`);
      const data = await apiPost("/api/connect", {
        local_node: getLocalNode(), remote_node: remote,
        mode, permanent: String(isPerm()),
      });
      showResult(data.message ?? data.error, !!data.error);
    });
  }

  document.getElementById("btn-disconnect")?.addEventListener("click", async () => {
    const remote = getRemote();
    if (!remote) { showResult("Enter a remote node number first.", true); return; }
    if (!confirm(`Disconnect node ${remote} from ${getLocalNode()}?`)) return;
    showResult("Disconnecting…");
    const data = await apiPost("/api/disconnect", {
      local_node: getLocalNode(), remote_node: remote, permanent: String(isPerm()),
    });
    showResult(data.message ?? data.error, !!data.error);
  });

  document.getElementById("btn-dtmf")?.addEventListener("click", async () => {
    const digits = getRemote();
    if (!digits) { showResult("Enter a DTMF command in the Remote/DTMF field.", true); return; }
    showResult(`Sending DTMF: ${digits}…`);
    const data = await apiPost("/api/dtmf", { local_node: getLocalNode(), digits });
    showResult(data.message ?? data.error, !!data.error);
  });

  document.getElementById("btn-run-cmd")?.addEventListener("click", async () => {
    const command = document.getElementById("cmd-select").value;
    showResult("Running command…");
    const data = await apiPost("/api/command", { local_node: getLocalNode(), command });
    showResult(data.error ? data.error : (data.output ?? "Done."), !!data.error);
  });

  document.getElementById("btn-login")?.addEventListener("click", () => {
    document.getElementById("login-dialog").classList.add("open");
    document.getElementById("dlg-user").focus();
  });

  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await apiPost("/api/logout", {});
    setLoggedIn(false, null);
  });
}

// ── Login dialog ──────────────────────────────────────────────────────────────

function wireLoginDialog() {
  const dialog = document.getElementById("login-dialog");
  const errMsg = document.getElementById("dlg-error");

  const close = () => {
    dialog.classList.remove("open");
    errMsg.style.display = "none";
    document.getElementById("dlg-pass").value = "";
  };

  const submit = async () => {
    errMsg.style.display = "none";
    const data = await apiPost("/api/login", {
      username: document.getElementById("dlg-user").value.trim(),
      password: document.getElementById("dlg-pass").value,
    });
    if (data.ok) {
      close();
      setLoggedIn(true, document.getElementById("dlg-user").value.trim());
      if (currentTab === "settings") loadSettings();
      if (currentTab === "favorites") loadFavorites();
    } else {
      errMsg.style.display = "block";
    }
  };

  document.getElementById("dlg-submit").addEventListener("click", submit);
  document.getElementById("dlg-cancel").addEventListener("click", close);
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
  document.getElementById("dlg-user").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("dlg-pass").focus();
  });
  document.getElementById("dlg-pass").addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatLastKeyed(secs) {
  if (secs == null || secs === -1) return "Never";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${pad3(h)}:${pad2(m)}:${pad2(s)}`;
}

function formatElapsed(secs) {
  if (secs == null || secs === 0) return "";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${h}h ${pad2(m)}m` : m > 0 ? `${m}m ${pad2(s)}s` : `${s}s`;
}

function modeLabel(mode) {
  return { T: "Transceive", R: "Receive Only", M: "Monitor", C: "Connecting" }[mode] ?? mode ?? "";
}

function pad2(n) { return String(n).padStart(2, "0"); }
function pad3(n) { return String(n).padStart(3, "0"); }

function escHtml(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function escAttr(s) {
  return String(s ?? "").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// ── Start ─────────────────────────────────────────────────────────────────────

boot().catch(console.error);
