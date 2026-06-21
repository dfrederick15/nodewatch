/**
 * app.js — AllStar Monitor client
 *
 * No external dependencies. Runs in any modern browser.
 *
 * Flow:
 *  1. On load, fetch /api/config for display settings and node list.
 *  2. Fetch /api/session to see if the user is already logged in.
 *  3. Open an SSE connection to /api/sse for real-time node updates.
 *  4. Render a table for each node; update it as SSE events arrive.
 *  5. Buttons (connect/disconnect/dtmf/command) POST to /api/* endpoints.
 */

// ── State ─────────────────────────────────────────────────────────────────────

let config = null;       // populated from /api/config
let loggedIn = false;
let nodeStatuses = {};   // node number → latest NodeStatus from server

// ── Boot ──────────────────────────────────────────────────────────────────────

async function boot() {
  await loadConfig();
  await checkSession();
  connectSSE();
  wireButtons();
  wireLoginDialog();
}

async function loadConfig() {
  const res = await fetch("/api/config");
  config = await res.json();

  // Update header
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
  for (const n of config.nodes) {
    area.appendChild(buildNodePanel(n));
  }
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
  const nodeNums = config.nodes.map(n => n.node).join(",");
  if (sseSource) sseSource.close();

  sseSource = new EventSource(`/api/sse?nodes=${nodeNums}`);

  sseSource.addEventListener("node_status", (e) => {
    const status = JSON.parse(e.data);
    nodeStatuses[status.node] = status;
    renderNodeTable(status.node, status);
    setStatusDot("connected");
    tick();
  });

  sseSource.addEventListener("node_times", (e) => {
    const data = JSON.parse(e.data);
    updateNodeTimes(data);
    tick();
  });

  sseSource.addEventListener("node_error", (e) => {
    const data = JSON.parse(e.data);
    showNodeError(data.node, data.error);
    setStatusDot("error");
  });

  sseSource.onerror = () => {
    setStatusDot("error");
    // Browser will auto-reconnect SSE; no manual retry needed
  };
}

function tick() {
  document.getElementById("spinner").textContent = spinChars[spinIdx % spinChars.length];
  spinIdx++;
}

// ── Render node tables ────────────────────────────────────────────────────────

function buildNodePanel(nodeCfg) {
  const panel = document.createElement("div");
  panel.className = "node-panel";
  panel.id = `panel-${nodeCfg.node}`;

  const header = document.createElement("div");
  header.className = "node-panel-header";
  header.innerHTML = `
    <span class="node-num">${nodeCfg.node}</span>
    <span class="node-label">${nodeCfg.label ?? ""}</span>
    <span class="state-badge idle" id="badge-${nodeCfg.node}">Idle</span>
  `;
  panel.appendChild(header);

  const tableWrap = document.createElement("div");
  tableWrap.id = `table-wrap-${nodeCfg.node}`;
  tableWrap.innerHTML = `<div class="no-connections">Waiting for data…</div>`;
  panel.appendChild(tableWrap);

  return panel;
}

function renderNodeTable(nodeNum, status) {
  const wrap = document.getElementById(`table-wrap-${nodeNum}`);
  if (!wrap) return;

  // Update state badge
  const badge = document.getElementById(`badge-${nodeNum}`);
  if (badge) {
    if (status.cos_keyed && status.tx_keyed) {
      badge.className = "state-badge fullduplex";
      badge.textContent = "Full Duplex";
    } else if (status.cos_keyed) {
      badge.className = "state-badge cos";
      badge.textContent = "COS";
    } else if (status.tx_keyed) {
      badge.className = "state-badge ptt";
      badge.textContent = "PTT";
    } else {
      badge.className = "state-badge idle";
      badge.textContent = "Idle";
    }
  }

  const conns = status.connections.filter(c => c.node !== "1");

  if (conns.length === 0) {
    wrap.innerHTML = `<div class="no-connections">No connections.</div>`;
    return;
  }

  const maxNodes = config.display.max_nodes;
  const showNever = config.display.show_never_heard;
  let rows = conns;
  if (!showNever) rows = rows.filter(c => c.last_keyed !== -1);
  if (maxNodes > 0) rows = rows.slice(0, maxNodes);

  // Sort: most recently heard first, never-heard at bottom
  rows.sort((a, b) => {
    if (a.last_keyed === -1 && b.last_keyed === -1) return 0;
    if (a.last_keyed === -1) return 1;
    if (b.last_keyed === -1) return -1;
    return a.last_keyed - b.last_keyed;
  });

  let html = `
    <table class="node-table">
      <thead>
        <tr>
          <th>Node</th>
          <th>Info</th>
          <th>Last Heard</th>
          <th>Link</th>
          <th>Dir</th>
          <th>Connected</th>
          <th>Mode</th>
        </tr>
      </thead>
      <tbody id="tbody-${nodeNum}">
  `;

  for (let i = 0; i < rows.length; i++) {
    const c = rows[i];
    const rowClass = c.keyed ? "keyed" : (c.link === "CONNECTING" ? "connecting" : "");
    html += `<tr class="${rowClass}" data-node="${c.node}" data-local="${nodeNum}">
      <td class="node-col">${c.node}</td>
      <td class="info-col">${escHtml(c.info ?? c.ip ?? "")}</td>
      <td class="muted-col" id="lkey-${nodeNum}-${i}">${formatLastKeyed(c.last_keyed)}</td>
      <td class="muted-col">${c.link}</td>
      <td class="muted-col">${c.direction}</td>
      <td class="muted-col" id="elap-${nodeNum}-${i}">${formatElapsed(c.elapsed)}</td>
      <td class="muted-col">${modeLabel(c.mode)}</td>
    </tr>`;
  }

  html += `</tbody></table>`;
  wrap.innerHTML = html;

  // Clicking a row populates the remote-input field
  wrap.querySelectorAll("tr[data-node]").forEach(row => {
    row.addEventListener("click", () => {
      document.getElementById("remote-input").value = row.dataset.node;
      document.getElementById("local-node").value = row.dataset.local;
    });
  });
}

function updateNodeTimes(data) {
  const conns = data.connections ?? [];
  const nodeNum = data.node;
  for (let i = 0; i < conns.length; i++) {
    const lkey = document.getElementById(`lkey-${nodeNum}-${i}`);
    const elap = document.getElementById(`elap-${nodeNum}-${i}`);
    if (lkey) lkey.textContent = formatLastKeyed(conns[i].last_keyed);
    if (elap) elap.textContent = formatElapsed(conns[i].elapsed);
  }
}

function showNodeError(nodeNum, msg) {
  const wrap = document.getElementById(`table-wrap-${nodeNum}`);
  if (wrap) wrap.innerHTML = `<div class="no-connections" style="color:var(--red)">${escHtml(msg)}</div>`;
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatLastKeyed(secs) {
  if (secs === -1) return "Never";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${pad3(h)}:${pad2(m)}:${pad2(s)}`;
}

function formatElapsed(secs) {
  if (!secs && secs !== 0) return "";
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
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── Auth state ────────────────────────────────────────────────────────────────

function setLoggedIn(yes, username) {
  loggedIn = yes;
  document.getElementById("auth-label").textContent = yes ? `${username}` : "Not logged in";
  document.getElementById("btn-login").style.display = yes ? "none" : "";
  document.getElementById("btn-logout").style.display = yes ? "" : "none";

  // Show/hide authenticated controls
  document.getElementById("link-controls").style.display = yes ? "" : "none";
  document.getElementById("cmd-controls").style.display = yes ? "" : "none";
  document.getElementById("control-panel").style.display = yes ? "" : "none";
}

function setStatusDot(state) {
  const dot = document.getElementById("status-dot");
  dot.className = state === "connected" ? "connected" : state === "error" ? "error" : "";
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

  // Connect / Monitor / Local Monitor
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
        local_node: getLocalNode(),
        remote_node: remote,
        mode,
        permanent: String(isPerm()),
      });
      showResult(data.message ?? data.error, !!data.error);
    });
  }

  // Disconnect
  document.getElementById("btn-disconnect")?.addEventListener("click", async () => {
    const remote = getRemote();
    if (!remote) { showResult("Enter a remote node number first.", true); return; }
    if (!confirm(`Disconnect node ${remote} from ${getLocalNode()}?`)) return;
    showResult("Disconnecting…");
    const data = await apiPost("/api/disconnect", {
      local_node: getLocalNode(),
      remote_node: remote,
      permanent: String(isPerm()),
    });
    showResult(data.message ?? data.error, !!data.error);
  });

  // DTMF
  document.getElementById("btn-dtmf")?.addEventListener("click", async () => {
    const digits = getRemote();
    if (!digits) { showResult("Enter a DTMF command in the Remote/DTMF field.", true); return; }
    showResult(`Sending DTMF: ${digits}…`);
    const data = await apiPost("/api/dtmf", {
      local_node: getLocalNode(),
      digits,
    });
    showResult(data.message ?? data.error, !!data.error);
  });

  // Control panel execute
  document.getElementById("btn-run-cmd")?.addEventListener("click", async () => {
    const command = document.getElementById("cmd-select").value;
    showResult("Running command…");
    const data = await apiPost("/api/command", {
      local_node: getLocalNode(),
      command,
    });
    if (data.error) {
      showResult(data.error, true);
    } else {
      showResult(data.output ?? "Done.");
    }
  });

  // Login/logout
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
    const username = document.getElementById("dlg-user").value.trim();
    const password = document.getElementById("dlg-pass").value;
    errMsg.style.display = "none";
    const data = await apiPost("/api/login", { username, password });
    if (data.ok) {
      close();
      setLoggedIn(true, username);
    } else {
      errMsg.style.display = "block";
    }
  };

  document.getElementById("dlg-submit").addEventListener("click", submit);
  document.getElementById("dlg-cancel").addEventListener("click", close);
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });

  // Enter key inside dialog submits
  document.getElementById("dlg-user").addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("dlg-pass").focus(); });
  document.getElementById("dlg-pass").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

// ── Start ─────────────────────────────────────────────────────────────────────

boot().catch(console.error);
