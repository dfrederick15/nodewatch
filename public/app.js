/**
 * app.js — AllStar Monitor client
 *
 * No external dependencies. Runs in any modern browser.
 *
 * Flow:
 *  1. Fetch /api/config — display settings, node list, command list.
 *  2. Fetch /api/session — check if already logged in.
 *  3. Open SSE to /api/sse — receive real-time node_status and node_times events.
 *  4. Render a table per node; clicking a row populates the control form.
 *  5. A local setInterval ticks elapsed/last-keyed counters every second
 *     so they increment smoothly without waiting for the next server poll.
 *  6. Connected remote nodes with subnodes show a ▶ expand button.
 */

// ── State ─────────────────────────────────────────────────────────────────────

let config = null;
let loggedIn = false;

// Live counter state: nodeNum → [ {elapsed, last_keyed, receivedAt}, ... ]
// Updated on every node_times SSE event; ticked client-side every second.
const liveTimes = {};

// Which rows are currently expanded to show subnodes
const expandedRows = new Set(); // keys like "65659-27339"

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  await loadConfig();
  await checkSession();
  connectSSE();
  startLiveTimer();
  wireButtons();
  wireLoginDialog();
}

async function loadConfig() {
  const res = await fetch("/api/config");
  config = await res.json();

  document.getElementById("hdr-callsign").textContent = config.display.callsign;
  document.getElementById("hdr-subtitle").textContent = config.display.title;
  document.title = config.display.title;

  // Populate local node selector
  const sel = document.getElementById("local-node");
  sel.innerHTML = "";
  for (const n of config.nodes) {
    const opt = document.createElement("option");
    opt.value = String(n.node);
    opt.textContent = n.label ? `${n.node} — ${n.label}` : String(n.node);
    sel.appendChild(opt);
  }

  // Populate command dropdown
  const cmdSel = document.getElementById("cmd-select");
  cmdSel.innerHTML = "";
  for (const cmd of config.commands) {
    const opt = document.createElement("option");
    opt.value = cmd.command;
    opt.textContent = cmd.label;
    cmdSel.appendChild(opt);
  }

  // Build empty node panels
  const area = document.getElementById("nodes-area");
  area.innerHTML = "";
  for (const n of config.nodes) area.appendChild(buildNodePanel(n));
}

async function checkSession() {
  const res = await fetch("/api/session");
  const data = await res.json();
  setLoggedIn(data.logged_in, data.username);
}

// ── SSE ───────────────────────────────────────────────────────────────────────

let sseSource = null;
const spinChars = ["|", "/", "-", "\\"];
let spinIdx = 0;

function connectSSE() {
  if (sseSource) sseSource.close();
  const nodeNums = config.nodes.map(n => n.node).join(",");
  sseSource = new EventSource(`/api/sse?nodes=${nodeNums}`);

  sseSource.addEventListener("node_status", (e) => {
    const status = JSON.parse(e.data);
    renderNodeTable(status.node, status);
    setStatusDot("connected");
    tick();
  });

  sseSource.addEventListener("node_times", (e) => {
    const data = JSON.parse(e.data);
    // Store received values with timestamp so the live timer can tick them
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

  sseSource.onerror = () => setStatusDot("error");
}

function tick() {
  document.getElementById("spinner").textContent = spinChars[spinIdx++ % spinChars.length];
}

// ── Live counter timer ────────────────────────────────────────────────────────
// Increments elapsed and last_keyed counters locally every second so they
// tick smoothly between server polls instead of jumping all at once.

function startLiveTimer() {
  setInterval(() => {
    const now = Date.now();
    for (const [nodeNum, conns] of Object.entries(liveTimes)) {
      conns.forEach((c, i) => {
        const delta = Math.floor((now - c.receivedAt) / 1000);
        const lk = c.last_keyed === -1 ? -1 : c.last_keyed + delta;
        const el = c.elapsed + delta;

        const lkEl = document.getElementById(`lkey-${nodeNum}-${i}`);
        const elEl = document.getElementById(`elap-${nodeNum}-${i}`);
        if (lkEl) lkEl.textContent = formatLastKeyed(lk);
        if (elEl) elEl.textContent = formatElapsed(el);
      });
    }
  }, 1000);
}

// ── Node panel rendering ──────────────────────────────────────────────────────

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

function renderNodeTable(nodeNum, status) {
  const wrap = document.getElementById(`table-wrap-${nodeNum}`);
  if (!wrap) return;

  // Update state badge
  const badge = document.getElementById(`badge-${nodeNum}`);
  if (badge) {
    const { cos_keyed, tx_keyed } = status;
    if (cos_keyed && tx_keyed) {
      badge.className = "state-badge fullduplex"; badge.textContent = "Full Duplex";
    } else if (cos_keyed) {
      badge.className = "state-badge cos";        badge.textContent = "COS";
    } else if (tx_keyed) {
      badge.className = "state-badge ptt";        badge.textContent = "PTT";
    } else {
      badge.className = "state-badge idle";       badge.textContent = "Idle";
    }
  }

  // Filter and sort connections
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
          <th style="width:28px"></th>
          <th>Node</th><th>Info</th><th>Last Heard</th>
          <th>Link</th><th>Dir</th><th>Connected</th><th>Mode</th>
        </tr>
      </thead>
      <tbody>`;

  for (let i = 0; i < conns.length; i++) {
    const c     = conns[i];
    const rowKey  = `${nodeNum}-${c.node}`;
    const hasSubnodes = Array.isArray(c.subnodes) && c.subnodes.length > 0;
    const isExpanded  = expandedRows.has(rowKey);
    const rowClass    = c.keyed ? "keyed" : c.link === "CONNECTING" ? "connecting" : "";

    html += `<tr class="${rowClass}" data-node="${escAttr(c.node)}" data-local="${escAttr(nodeNum)}">
      <td class="expand-cell">
        ${hasSubnodes
          ? `<button class="expand-btn" data-key="${escAttr(rowKey)}" title="${c.subnodes.length} node(s) connected to ${c.node}">${isExpanded ? "▼" : "▶"}</button>`
          : ""}
      </td>
      <td class="node-col">${escHtml(c.node)}</td>
      <td class="info-col">${escHtml(c.info || c.ip || "")}</td>
      <td class="muted-col" id="lkey-${nodeNum}-${i}">${formatLastKeyed(c.last_keyed)}</td>
      <td class="muted-col">${escHtml(c.link)}</td>
      <td class="muted-col">${escHtml(c.direction)}</td>
      <td class="muted-col" id="elap-${nodeNum}-${i}">${formatElapsed(c.elapsed)}</td>
      <td class="muted-col">${modeLabel(c.mode)}</td>
    </tr>`;

    // Subnode rows (hidden unless expanded)
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

  // Click on a data row → populate the control form
  wrap.querySelectorAll("tr[data-node]").forEach(row => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".expand-btn")) return; // don't hijack expand button
      document.getElementById("remote-input").value = row.dataset.node;
      document.getElementById("local-node").value   = row.dataset.local;
    });
  });

  // Expand/collapse buttons
  wrap.querySelectorAll(".expand-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.key;
      if (expandedRows.has(key)) {
        expandedRows.delete(key);
        btn.textContent = "▶";
      } else {
        expandedRows.add(key);
        btn.textContent = "▼";
      }
      // Toggle visibility of matching subnode rows
      wrap.querySelectorAll(`.subnode-row[data-parent="${CSS.escape(key)}"]`).forEach(row => {
        row.classList.toggle("subnode-hidden");
      });
    });
  });
}

function showNodeError(nodeNum, msg) {
  const wrap = document.getElementById(`table-wrap-${nodeNum}`);
  if (wrap) wrap.innerHTML = `<div class="no-connections" style="color:var(--red)">${escHtml(msg)}</div>`;
}

// ── Formatting ─────────────────────────────────────────────────────────────────

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
}

// ── API calls ─────────────────────────────────────────────────────────────────

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

// ── Button wiring ─────────────────────────────────────────────────────────────

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
    if (data.ok) { close(); setLoggedIn(true, document.getElementById("dlg-user").value.trim()); }
    else errMsg.style.display = "block";
  };

  document.getElementById("dlg-submit").addEventListener("click", submit);
  document.getElementById("dlg-cancel").addEventListener("click", close);
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
  document.getElementById("dlg-user").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("dlg-pass").focus(); });
  document.getElementById("dlg-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

// ── Start ─────────────────────────────────────────────────────────────────────

boot().catch(console.error);
