# Scheduled Node Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add recurring day-of-week scheduled connect/disconnect between AllStar nodes, managed via a new Schedule tab with a weekly grid UI.

**Architecture:** A minute-tick `setInterval` in `server.ts` reads `cfg.schedules` on each tick and fires `ilink` calls directly. Schedules are stored as `[[schedules]]` in `config.toml`. The UI is a CSS-grid weekly calendar (Sun–Sat columns, 15-min rows) rendered in a new Schedule tab in `app.js`.

**Tech Stack:** Node.js 22 `--experimental-strip-types`, `smol-toml`, vanilla JS/CSS — no new dependencies.

## Global Constraints

- No new npm dependencies.
- All TypeScript runs via `--experimental-strip-types` — no build step.
- Times are HH:MM strings, interpreted in `cfg.display.timezone`.
- Days are lowercase 3-letter strings: `sun mon tue wed thu fri sat`.
- Auth required for all write endpoints (use existing `requireAuth()`).
- Do NOT call `process.exit()` after config writes — update `cfg` in-memory and write to disk.
- `serializeConfig()` in `server.ts` is the only place config is written to TOML.

---

### Task 1: Schedule type + config serialization

**Files:**
- Modify: `server.ts` (lines ~102–193)

**Interfaces:**
- Produces:
  - `Schedule` interface (exported via in-memory `cfg.schedules`)
  - `cfg.schedules: Schedule[]` available to all later tasks

- [ ] **Step 1: Add `Schedule` interface and extend `Config`**

  In `server.ts`, after the `NodeConfig` interface (around line 100), add:

  ```typescript
  interface Schedule {
    label: string;
    node: number;
    remote: number;
    days: string[];       // ["sun","mon","tue","wed","thu","fri","sat"] subset
    connect: string;      // "HH:MM"
    disconnect?: string;  // "HH:MM" — omit for connect-only
    mode: string;         // "connect" | "monitor" | "localmonitor"
    permanent: boolean;
    enabled: boolean;
  }
  ```

  In the `Config` interface, add after `commands`:

  ```typescript
  schedules?: Schedule[];
  ```

- [ ] **Step 2: Extend `serializeConfig` to emit `[[schedules]]` blocks**

  In `serializeConfig()`, after the `[[commands]]` loop (around line 191), add:

  ```typescript
  for (const s of c.schedules ?? []) {
    L.push("[[schedules]]");
    L.push(`label      = ${tomlStr(s.label)}`);
    L.push(`node       = ${Number(s.node)}`);
    L.push(`remote     = ${Number(s.remote)}`);
    L.push(`days       = [${s.days.map(d => tomlStr(d)).join(", ")}]`);
    L.push(`connect    = ${tomlStr(s.connect)}`);
    if (s.disconnect) L.push(`disconnect = ${tomlStr(s.disconnect)}`);
    L.push(`mode       = ${tomlStr(s.mode ?? "connect")}`);
    L.push(`permanent  = ${s.permanent ?? false}`);
    L.push(`enabled    = ${s.enabled ?? true}`);
    L.push("");
  }
  ```

- [ ] **Step 3: Verify config round-trip**

  Manually add this to `config.toml`:

  ```toml
  [[schedules]]
  label      = "Test Net"
  node       = 1234
  remote     = 99999
  days       = ["wed"]
  connect    = "19:00"
  disconnect = "20:00"
  mode       = "connect"
  permanent  = false
  enabled    = true
  ```

  Start the server: `npm start`

  Expected console: no errors, server starts. Then verify the GET endpoint (added in Task 2) returns this entry. For now, just confirm the server starts cleanly.

- [ ] **Step 4: Commit**

  ```bash
  git add server.ts
  git commit -m "Add Schedule type and config serialization"
  ```

---

### Task 2: GET/POST /api/schedules endpoints

**Files:**
- Modify: `server.ts` (around line 640, after the provision endpoints)

**Interfaces:**
- Consumes: `cfg.schedules: Schedule[]`, `requireAuth()`, `serializeConfig()`, `configPath`
- Produces:
  - `GET /api/schedules` → `{ schedules: Schedule[] }` (each entry has `id: number` = array index)
  - `POST /api/schedules` body `{ schedules: Schedule[] }` → `{ ok: true }`

- [ ] **Step 1: Add GET /api/schedules**

  In `server.ts`, inside the HTTP handler, after the provision script endpoint and before the auth-gated write block (around line 655), add:

  ```typescript
  if (pathname === "/api/schedules" && req.method === "GET") {
    const list = (cfg.schedules ?? []).map((s, i) => ({ ...s, id: i }));
    json(res, 200, { schedules: list });
    return;
  }
  ```

- [ ] **Step 2: Add POST /api/schedules**

  Immediately after the GET handler:

  ```typescript
  if (pathname === "/api/schedules" && req.method === "POST") {
    if (!requireAuth(req, res)) return;
    const body = await readBody(req) as unknown as { schedules: Schedule[] };
    if (!Array.isArray(body.schedules)) {
      json(res, 400, { error: "schedules must be an array" }); return;
    }
    cfg.schedules = body.schedules;
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, configPath + ".bak");
    fs.writeFileSync(configPath, serializeConfig(cfg), "utf8");
    json(res, 200, { ok: true });
    return;
  }
  ```

- [ ] **Step 3: Verify GET endpoint**

  Start server: `npm start`

  ```bash
  curl -s http://localhost:8080/api/schedules | python3 -m json.tool
  ```

  Expected output (with the test entry from Task 1 still in config.toml):
  ```json
  {
    "schedules": [
      {
        "id": 0,
        "label": "Test Net",
        "node": 1234,
        "remote": 99999,
        "days": ["wed"],
        "connect": "19:00",
        "disconnect": "20:00",
        "mode": "connect",
        "permanent": false,
        "enabled": true
      }
    ]
  }
  ```

- [ ] **Step 4: Verify POST endpoint requires auth**

  ```bash
  curl -s -X POST http://localhost:8080/api/schedules \
    -H "Content-Type: application/json" \
    -d '{"schedules":[]}'
  ```

  Expected: `{"error":"Not logged in"}`

- [ ] **Step 5: Verify POST saves and round-trips**

  First login to get a session cookie:
  ```bash
  curl -s -c /tmp/nw_cookie.txt -X POST http://localhost:8080/api/login \
    -H "Content-Type: application/json" \
    -d '{"username":"admin","password":"changeme"}'
  ```

  Then POST a schedule:
  ```bash
  curl -s -b /tmp/nw_cookie.txt -X POST http://localhost:8080/api/schedules \
    -H "Content-Type: application/json" \
    -d '{"schedules":[{"label":"Morning Check","node":1234,"remote":99999,"days":["mon","wed","fri"],"connect":"08:00","disconnect":"08:30","mode":"connect","permanent":false,"enabled":true}]}'
  ```

  Expected: `{"ok":true}`

  Verify it persisted:
  ```bash
  curl -s http://localhost:8080/api/schedules | python3 -m json.tool
  grep -A5 '\[\[schedules\]\]' config.toml
  ```

  Expected: schedule appears in both API response and config.toml.

- [ ] **Step 6: Remove the test entry from config.toml**

  Edit `config.toml` and delete the `[[schedules]]` block added manually in Task 1 (the POST saved a clean entry; clean up any duplicates so config.toml has exactly what the POST wrote).

  Restart server and confirm `GET /api/schedules` still returns the single entry.

- [ ] **Step 7: Commit**

  ```bash
  git add server.ts config.toml
  git commit -m "Add GET/POST /api/schedules endpoints"
  ```

---

### Task 3: Scheduler engine

**Files:**
- Modify: `server.ts` (after the SSE keepalive block, around line 512)

**Interfaces:**
- Consumes: `cfg.schedules`, `cfg.display.timezone`, `ensureConnected()`, `conn.client.ilink()`
- Produces: `runScheduler()` — called once at startup; fires `ilink` connect/disconnect per schedule

- [ ] **Step 1: Add `localDayTime` helper**

  In `server.ts`, before `runScheduler`, add:

  ```typescript
  function localDayTime(tz: string): { day: string; time: string } {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? "0";
    const rawHour = get("hour");
    const hour = rawHour === "24" ? "00" : rawHour.padStart(2, "0");
    return {
      day: get("weekday").toLowerCase().slice(0, 3),
      time: `${hour}:${get("minute").padStart(2, "0")}`,
    };
  }
  ```

- [ ] **Step 2: Add `runScheduler`**

  Immediately after `localDayTime`:

  ```typescript
  function runScheduler(): void {
    const ilinkCodes: Record<string, [number, number]> = {
      connect: [3, 13], monitor: [2, 12], localmonitor: [8, 18],
    };

    setInterval(async () => {
      const tz = cfg.display.timezone ?? "America/New_York";
      const { day, time } = localDayTime(tz);

      for (const sched of cfg.schedules ?? []) {
        if (!sched.enabled) continue;
        if (!sched.days.includes(day)) continue;

        if (time === sched.connect) {
          const nodeCfg = cfg.nodes.find(n => n.node === sched.node);
          if (!nodeCfg) {
            console.warn(`Scheduler: node ${sched.node} not in config ("${sched.label}")`);
            continue;
          }
          const [temp, perm] = ilinkCodes[sched.mode ?? "connect"] ?? ilinkCodes.connect;
          const code = sched.permanent ? perm : temp;
          try {
            const conn = await ensureConnected(nodeCfg);
            await conn.client.ilink(conn.socket!, String(sched.node), String(sched.remote), code);
            console.log(`Scheduler: connected ${sched.node} → ${sched.remote} ("${sched.label}")`);
          } catch (err) {
            console.error(`Scheduler: connect failed for "${sched.label}":`, (err as Error).message);
          }
        }

        if (sched.disconnect && time === sched.disconnect) {
          const nodeCfg = cfg.nodes.find(n => n.node === sched.node);
          if (!nodeCfg) continue;
          const code = sched.permanent ? 11 : 1;
          try {
            const conn = await ensureConnected(nodeCfg);
            await conn.client.ilink(conn.socket!, String(sched.node), String(sched.remote), code);
            console.log(`Scheduler: disconnected ${sched.node} ↔ ${sched.remote} ("${sched.label}")`);
          } catch (err) {
            console.error(`Scheduler: disconnect failed for "${sched.label}":`, (err as Error).message);
          }
        }
      }
    }, 60_000);
  }
  ```

- [ ] **Step 3: Call `runScheduler()` at startup**

  After the existing `pollNodes()` call (around line 504), add:

  ```typescript
  runScheduler();
  ```

- [ ] **Step 4: Verify scheduler fires (smoke test)**

  Set a schedule entry for the current minute (check your local time in the configured timezone) via the API:

  ```bash
  # Get current HH:MM in your timezone first, then set connect 1 minute from now
  curl -s -b /tmp/nw_cookie.txt -X POST http://localhost:8080/api/schedules \
    -H "Content-Type: application/json" \
    -d '{"schedules":[{"label":"Smoke Test","node":1234,"remote":99999,"days":["mon","tue","wed","thu","fri","sat","sun"],"connect":"HH:MM","mode":"connect","permanent":false,"enabled":true}]}'
  ```

  Watch the server log. At the target minute you should see:
  ```
  Scheduler: connected 1234 → 99999 ("Smoke Test")
  ```
  (It will also log an AMI error if node 1234 isn't reachable — that's fine, the scheduler itself fired correctly.)

  After verifying, clear the test schedule:
  ```bash
  curl -s -b /tmp/nw_cookie.txt -X POST http://localhost:8080/api/schedules \
    -H "Content-Type: application/json" \
    -d '{"schedules":[]}'
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add server.ts
  git commit -m "Add minute-tick scheduler engine for node connect/disconnect"
  ```

---

### Task 4: Schedule tab — HTML skeleton

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js` (tab routing section, around line 160)

**Interfaces:**
- Produces: `tab-schedule` panel visible when Schedule tab clicked; `loadSchedules()` called on switch

- [ ] **Step 1: Add tab button and panel to index.html**

  In `index.html`, in the `<nav id="tab-bar">` block, add the Schedule button between Favorites and Settings:

  ```html
  <button class="tab-btn" data-tab="schedule">Schedule</button>
  ```

  In `index.html`, in the `<div id="content-area">` block, add the Schedule panel after the Favorites panel:

  ```html
  <!-- Schedule tab -->
  <div id="tab-schedule" class="tab-panel">
    <div id="schedule-area"></div>
  </div>
  ```

- [ ] **Step 2: Wire `loadSchedules()` in tab routing**

  In `app.js`, in `switchTab()` (around line 176), add after the `if (name === "settings")` line:

  ```javascript
  if (name === "schedule") loadSchedules();
  ```

- [ ] **Step 3: Add stub `loadSchedules` function**

  In `app.js`, after the `loadSettings` function, add:

  ```javascript
  async function loadSchedules() {
    const area = document.getElementById("schedule-area");
    area.textContent = "Loading…";
    const res = await fetch("/api/schedules");
    const data = await res.json();
    area.textContent = `${(data.schedules ?? []).length} schedule(s) loaded.`;
  }
  ```

- [ ] **Step 4: Verify tab appears and stub loads**

  Start server: `npm start`

  Open `http://localhost:8080`. Click the **Schedule** tab.

  Expected: tab becomes active, content area shows "0 schedule(s) loaded." (or the count from your config).

  Sidebar should hide (same behavior as Favorites/Settings — the `wide` class is toggled in `switchTab`).

- [ ] **Step 5: Commit**

  ```bash
  git add public/index.html public/app.js
  git commit -m "Add Schedule tab skeleton"
  ```

---

### Task 5: Weekly grid rendering

**Files:**
- Modify: `public/app.js` (replace `loadSchedules` stub)
- Modify: `public/style.css`

**Interfaces:**
- Consumes: `GET /api/schedules` response, `config.nodes`
- Produces: `buildScheduleGrid(schedules, nodes)` → `HTMLElement` (the grid)

- [ ] **Step 1: Add CSS for the grid**

  In `public/style.css`, append:

  ```css
  /* ── Schedule tab ──────────────────────────────────────── */

  #schedule-area {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .sched-toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .sched-wrapper {
    overflow-y: auto;
    max-height: calc(100vh - 160px);
    border: 1px solid var(--border);
    border-radius: 4px;
    position: relative;
  }

  .sched-header {
    display: grid;
    grid-template-columns: 52px repeat(7, 1fr);
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--bg-panel);
    border-bottom: 2px solid var(--border);
  }

  .sched-header-corner { padding: 6px; }

  .sched-day-hdr {
    padding: 6px 4px;
    text-align: center;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.05em;
    color: var(--muted);
    border-left: 1px solid var(--border);
  }

  .sched-body {
    display: grid;
    grid-template-columns: 52px repeat(7, 1fr);
    grid-template-rows: repeat(96, 16px);
    position: relative;
  }

  .sched-time-lbl {
    font-size: 10px;
    color: var(--muted);
    padding-right: 6px;
    text-align: right;
    line-height: 16px;
    white-space: nowrap;
    align-self: start;
  }

  .sched-cell {
    border-left: 1px solid var(--border);
    border-top: 1px solid transparent;
  }

  .sched-cell.hour-line {
    border-top-color: var(--border);
  }

  .sched-block {
    border-radius: 3px;
    padding: 2px 4px;
    font-size: 11px;
    overflow: hidden;
    cursor: pointer;
    opacity: 0.85;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0 2px;
    box-sizing: border-box;
    transition: opacity 0.15s;
  }

  .sched-block:hover { opacity: 1; }

  .sched-block.active {
    box-shadow: 0 0 0 2px var(--accent);
    opacity: 1;
  }

  .sched-block.disabled { opacity: 0.35; }

  .sched-block-label {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #fff;
  }

  .sched-block-node {
    font-size: 10px;
    color: rgba(255,255,255,0.8);
    white-space: nowrap;
  }

  /* ── Schedule modal ─────────────────────────────────────── */

  #sched-modal {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.6);
    z-index: 100;
    align-items: center;
    justify-content: center;
  }

  #sched-modal.open { display: flex; }

  .sched-modal-box {
    background: var(--bg-panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 24px;
    width: 420px;
    max-width: 95vw;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .sched-modal-box h3 { margin: 0; font-size: 15px; }

  .sched-days-row {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .sched-days-row label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 13px;
    cursor: pointer;
  }

  .sched-modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
    margin-top: 4px;
  }

  .sched-modal-error {
    color: var(--red);
    font-size: 13px;
    display: none;
  }
  ```

- [ ] **Step 2: Add `timeToSlot` and `localDayTimeClient` helpers in app.js**

  In `app.js`, after the `tickClock` function (around line 156), add:

  ```javascript
  function timeToSlot(hhmm) {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 4 + Math.floor(m / 15);
  }

  function localDayTimeClient() {
    const tz = config?.display?.timezone ?? "America/New_York";
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t)?.value ?? "0";
    const rawHour = get("hour");
    const hour = rawHour === "24" ? "00" : rawHour.padStart(2, "0");
    return {
      day: get("weekday").toLowerCase().slice(0, 3),
      time: `${hour}:${get("minute").padStart(2, "0")}`,
    };
  }

  function isSchedActive(sched) {
    const { day, time } = localDayTimeClient();
    if (!sched.days.includes(day)) return false;
    if (time < sched.connect) return false;
    if (sched.disconnect && time >= sched.disconnect) return false;
    return true;
  }
  ```

- [ ] **Step 3: Add `buildScheduleGrid` function**

  In `app.js`, after `isSchedActive`, add:

  ```javascript
  const SCHED_COLORS = [
    "#4a6fa5", "#5a8a5a", "#8a5a4a", "#7a5a8a", "#8a7a4a", "#4a8a8a", "#8a5a6a",
  ];
  const DAYS_ORDER = ["sun","mon","tue","wed","thu","fri","sat"];
  const DAYS_LABEL = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const DAY_COL    = { sun:2, mon:3, tue:4, wed:5, thu:6, fri:7, sat:8 };

  function buildScheduleGrid(schedules, nodes, onBlockClick) {
    const wrap = document.createElement("div");
    wrap.className = "sched-wrapper";

    // Sticky header
    const hdr = document.createElement("div");
    hdr.className = "sched-header";
    const corner = document.createElement("div");
    corner.className = "sched-header-corner";
    hdr.appendChild(corner);
    for (const lbl of DAYS_LABEL) {
      const d = document.createElement("div");
      d.className = "sched-day-hdr";
      d.textContent = lbl;
      hdr.appendChild(d);
    }
    wrap.appendChild(hdr);

    // Body grid
    const body = document.createElement("div");
    body.className = "sched-body";

    // Time labels and background cells
    for (let slot = 0; slot < 96; slot++) {
      const h = Math.floor(slot / 4);
      const m = (slot % 4) * 15;
      const isHour = m === 0;
      const row = slot + 1;  // grid rows are 1-indexed

      const lbl = document.createElement("div");
      lbl.className = "sched-time-lbl";
      lbl.style.gridRow = String(row);
      lbl.style.gridColumn = "1";
      if (isHour) lbl.textContent = `${String(h).padStart(2,"0")}:00`;
      body.appendChild(lbl);

      for (let d = 0; d < 7; d++) {
        const cell = document.createElement("div");
        cell.className = "sched-cell" + (isHour ? " hour-line" : "");
        cell.style.gridRow = String(row);
        cell.style.gridColumn = String(d + 2);
        body.appendChild(cell);
      }
    }

    // Schedule blocks
    schedules.forEach((sched, idx) => {
      const startSlot = timeToSlot(sched.connect);
      const endSlot   = sched.disconnect ? timeToSlot(sched.disconnect) : startSlot + 1;
      const color     = SCHED_COLORS[idx % SCHED_COLORS.length];
      const active    = isSchedActive(sched);

      for (const day of sched.days) {
        const col = DAY_COL[day];
        if (!col) continue;

        const block = document.createElement("div");
        block.className = "sched-block"
          + (active ? " active" : "")
          + (!sched.enabled ? " disabled" : "");
        block.style.gridRow    = `${startSlot + 1} / ${endSlot + 1}`;
        block.style.gridColumn = String(col);
        block.style.backgroundColor = color;

        const labelEl = document.createElement("span");
        labelEl.className = "sched-block-label";
        labelEl.textContent = sched.label;

        const nodeEl = document.createElement("span");
        nodeEl.className = "sched-block-node";
        nodeEl.textContent = `→ ${sched.remote}`;

        block.appendChild(labelEl);
        block.appendChild(nodeEl);
        block.addEventListener("click", () => onBlockClick(sched, idx));
        body.appendChild(block);
      }
    });

    wrap.appendChild(body);

    // Auto-scroll to 06:00 on load
    requestAnimationFrame(() => {
      wrap.scrollTop = 6 * 4 * 16; // slot 24 * 16px row height
    });

    return wrap;
  }
  ```

- [ ] **Step 4: Update `loadSchedules` to use the grid**

  Replace the stub `loadSchedules` with:

  ```javascript
  async function loadSchedules() {
    const area = document.getElementById("schedule-area");
    area.innerHTML = "";

    const res = await fetch("/api/schedules");
    if (!res.ok) {
      area.innerHTML = `<div class="error">Failed to load schedules.</div>`;
      return;
    }
    const data = await res.json();
    const schedules = data.schedules ?? [];

    // Toolbar
    const toolbar = document.createElement("div");
    toolbar.className = "sched-toolbar";
    const addBtn = document.createElement("button");
    addBtn.className = "primary";
    addBtn.textContent = "+ Add Schedule";
    addBtn.addEventListener("click", () => openSchedModal(null, -1, schedules));
    toolbar.appendChild(addBtn);
    area.appendChild(toolbar);

    // Grid
    const grid = buildScheduleGrid(schedules, config.nodes,
      (sched, idx) => openSchedModal(sched, idx, schedules));
    area.appendChild(grid);
  }
  ```

- [ ] **Step 5: Verify grid renders**

  Start server: `npm start`

  Add a test schedule via curl (use real node numbers from your config):

  ```bash
  curl -s -b /tmp/nw_cookie.txt -X POST http://localhost:8080/api/schedules \
    -H "Content-Type: application/json" \
    -d '{"schedules":[{"label":"Wednesday Net","node":1234,"remote":99999,"days":["wed"],"connect":"19:00","disconnect":"20:00","mode":"connect","permanent":false,"enabled":true}]}'
  ```

  Open `http://localhost:8080`, click **Schedule** tab.

  Expected:
  - Sticky header row: Sun Mon Tue Wed Thu Fri Sat
  - Hour labels on left (00:00, 01:00, …, 23:00)
  - A colored block visible in the Wed column from 19:00 to 20:00
  - Grid auto-scrolled to 06:00 on load

- [ ] **Step 6: Commit**

  ```bash
  git add public/app.js public/style.css
  git commit -m "Add Schedule tab weekly grid"
  ```

---

### Task 6: Add/Edit modal

**Files:**
- Modify: `public/app.js`
- Modify: `public/index.html`

**Interfaces:**
- Consumes: `loadSchedules()`, `GET /api/schedules`, `POST /api/schedules`, `config.nodes`
- Produces: `openSchedModal(sched, idx, schedules)` — opens modal pre-filled (edit) or blank (add)

- [ ] **Step 1: Add modal HTML to index.html**

  In `index.html`, before `<script src="app.js">`, add:

  ```html
  <!-- ── Schedule modal ── -->
  <div id="sched-modal">
    <div class="sched-modal-box">
      <h3 id="sched-modal-title">Add Schedule</h3>
      <div class="field-row">
        <label>Label</label>
        <input type="text" id="sm-label" placeholder="e.g. Wednesday Net">
      </div>
      <div class="field-row">
        <label>Local Node</label>
        <select id="sm-node"></select>
      </div>
      <div class="field-row">
        <label>Remote Node</label>
        <input type="number" id="sm-remote" placeholder="e.g. 67890">
      </div>
      <div>
        <label style="display:block;margin-bottom:6px">Days</label>
        <div class="sched-days-row" id="sm-days">
          <label><input type="checkbox" value="sun"> Sun</label>
          <label><input type="checkbox" value="mon"> Mon</label>
          <label><input type="checkbox" value="tue"> Tue</label>
          <label><input type="checkbox" value="wed"> Wed</label>
          <label><input type="checkbox" value="thu"> Thu</label>
          <label><input type="checkbox" value="fri"> Fri</label>
          <label><input type="checkbox" value="sat"> Sat</label>
        </div>
      </div>
      <div class="field-row">
        <label>Connect Time</label>
        <input type="time" id="sm-connect">
      </div>
      <div class="field-row">
        <label>Disconnect Time <span class="muted" style="font-size:11px">(optional)</span></label>
        <input type="time" id="sm-disconnect">
      </div>
      <div class="field-row">
        <label>Mode</label>
        <select id="sm-mode">
          <option value="connect">Connect</option>
          <option value="monitor">Monitor</option>
          <option value="localmonitor">Local Monitor</option>
        </select>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="sm-permanent">
        <label for="sm-permanent">Permanent link (survives rpt restart)</label>
      </div>
      <div class="checkbox-row">
        <input type="checkbox" id="sm-enabled" checked>
        <label for="sm-enabled">Enabled</label>
      </div>
      <div class="sched-modal-error" id="sm-error"></div>
      <div class="sched-modal-actions">
        <button id="sm-delete" class="danger" style="margin-right:auto;display:none">Delete</button>
        <button id="sm-cancel">Cancel</button>
        <button id="sm-save" class="primary">Save</button>
      </div>
    </div>
  </div>
  ```

- [ ] **Step 2: Add `openSchedModal` and `closeSchedModal` to app.js**

  In `app.js`, after `buildScheduleGrid`, add:

  ```javascript
  function closeSchedModal() {
    document.getElementById("sched-modal").classList.remove("open");
  }

  function openSchedModal(sched, idx, allSchedules) {
    const modal = document.getElementById("sched-modal");
    const isEdit = idx >= 0 && sched !== null;

    document.getElementById("sched-modal-title").textContent = isEdit ? "Edit Schedule" : "Add Schedule";
    document.getElementById("sm-label").value     = sched?.label ?? "";
    document.getElementById("sm-remote").value    = sched?.remote ?? "";
    document.getElementById("sm-connect").value   = sched?.connect ?? "";
    document.getElementById("sm-disconnect").value = sched?.disconnect ?? "";
    document.getElementById("sm-mode").value      = sched?.mode ?? "connect";
    document.getElementById("sm-permanent").checked = sched?.permanent ?? false;
    document.getElementById("sm-enabled").checked   = sched?.enabled ?? true;
    document.getElementById("sm-error").style.display = "none";
    document.getElementById("sm-delete").style.display = isEdit ? "" : "none";

    // Populate local node dropdown
    const nodeSel = document.getElementById("sm-node");
    nodeSel.innerHTML = "";
    for (const n of config.nodes) {
      const opt = document.createElement("option");
      opt.value = String(n.node);
      opt.textContent = n.label ? `${n.node} — ${n.label}` : String(n.node);
      if (sched?.node === n.node) opt.selected = true;
      nodeSel.appendChild(opt);
    }

    // Set day checkboxes
    const dayBoxes = document.querySelectorAll("#sm-days input[type=checkbox]");
    for (const cb of dayBoxes) {
      cb.checked = sched?.days?.includes(cb.value) ?? false;
    }

    // Wire Save
    const saveBtn = document.getElementById("sm-save");
    const newSave = saveBtn.cloneNode(true);
    saveBtn.parentNode.replaceChild(newSave, saveBtn);
    newSave.addEventListener("click", async () => {
      const days = [...document.querySelectorAll("#sm-days input:checked")].map(c => c.value);
      if (!days.length) {
        showSchedModalError("Select at least one day."); return;
      }
      const connectVal = document.getElementById("sm-connect").value;
      if (!connectVal) {
        showSchedModalError("Connect time is required."); return;
      }
      const entry = {
        label:      document.getElementById("sm-label").value.trim() || "Untitled",
        node:       Number(document.getElementById("sm-node").value),
        remote:     Number(document.getElementById("sm-remote").value),
        days,
        connect:    connectVal,
        disconnect: document.getElementById("sm-disconnect").value || undefined,
        mode:       document.getElementById("sm-mode").value,
        permanent:  document.getElementById("sm-permanent").checked,
        enabled:    document.getElementById("sm-enabled").checked,
      };
      const updated = [...allSchedules];
      if (isEdit) updated[idx] = entry;
      else updated.push(entry);
      await saveSchedules(updated);
    });

    // Wire Delete
    const delBtn = document.getElementById("sm-delete");
    const newDel = delBtn.cloneNode(true);
    delBtn.parentNode.replaceChild(newDel, delBtn);
    newDel.style.display = isEdit ? "" : "none";
    newDel.addEventListener("click", async () => {
      if (!confirm(`Delete schedule "${sched.label}"?`)) return;
      const updated = allSchedules.filter((_, i) => i !== idx);
      await saveSchedules(updated);
    });

    // Wire Cancel
    const cancelBtn = document.getElementById("sm-cancel");
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    newCancel.addEventListener("click", closeSchedModal);

    // Close on backdrop click
    modal.onclick = (e) => { if (e.target === modal) closeSchedModal(); };

    modal.classList.add("open");
  }

  function showSchedModalError(msg) {
    const el = document.getElementById("sm-error");
    el.textContent = msg;
    el.style.display = "block";
  }

  async function saveSchedules(schedules) {
    const res = await apiPost("/api/schedules", { schedules });
    if (res.error) {
      showSchedModalError(res.error); return;
    }
    closeSchedModal();
    loadSchedules();
  }
  ```

- [ ] **Step 3: Verify add flow**

  Start server: `npm start`, open `http://localhost:8080`, click **Schedule**.

  Click **+ Add Schedule**. Modal should appear with blank fields.

  Fill in:
  - Label: "Test Net"
  - Local Node: (select from dropdown)
  - Remote Node: 99999
  - Days: check Wed
  - Connect Time: 19:00
  - Disconnect Time: 20:00
  - Mode: Connect
  - Enabled: checked

  Click **Save**. Expected: modal closes, grid re-renders with a block in Wed column 19:00–20:00.

- [ ] **Step 4: Verify edit flow**

  Click the block you just created. Modal should open pre-filled with all values.

  Change the label to "Updated Net", click **Save**. Block should show new label.

- [ ] **Step 5: Verify delete flow**

  Click the block, click **Delete**, confirm. Grid should re-render with no blocks.

  Verify via curl:
  ```bash
  curl -s http://localhost:8080/api/schedules | python3 -m json.tool
  ```
  Expected: `{"schedules": []}`

- [ ] **Step 6: Verify validation**

  Click **+ Add Schedule**, leave Days unchecked, click **Save**.
  Expected: inline error "Select at least one day." — modal stays open.

  Check Days but leave Connect Time blank, click **Save**.
  Expected: inline error "Connect time is required."

- [ ] **Step 7: Commit**

  ```bash
  git add public/app.js public/index.html public/style.css
  git commit -m "Add schedule add/edit modal with full CRUD"
  ```

---

### Task 7: Push and deploy

**Files:** none changed — deploy only

- [ ] **Step 1: Run a final end-to-end check**

  With the server running locally:

  1. Open Schedule tab — grid renders, auto-scrolls to 06:00.
  2. Add a schedule spanning multiple days (e.g. Mon+Wed, 19:00–20:00). Verify blocks appear in both columns.
  3. Edit the schedule: add Fri. Verify third column block appears.
  4. Toggle Enabled off (edit modal → uncheck Enabled → Save). Verify block renders dimmed (`.disabled` class).
  5. Delete the schedule. Verify grid is empty.
  6. Check `config.toml` — no stale `[[schedules]]` entries.

- [ ] **Step 2: Push to GitHub**

  ```bash
  git push origin main
  ```

- [ ] **Step 3: Deploy to main server (172.16.11.188)**

  ```bash
  ssh asl@172.16.11.188 -p 22 "sudo git -C /opt/nodewatch pull && sudo systemctl restart nodewatch"
  ```

- [ ] **Step 4: Deploy to second server (192.168.150.166)**

  ```bash
  ssh asl@192.168.150.166 -p 222 "sudo git -C /opt/nodewatch pull && sudo systemctl restart nodewatch"
  ```

  Also apply the `Restart=always` fix if not already done on this server:
  ```bash
  ssh asl@192.168.150.166 -p 222 "sudo sed -i 's/Restart=on-failure/Restart=always/' /etc/systemd/system/nodewatch.service && sudo systemctl daemon-reload"
  ```

- [ ] **Step 5: Verify on each server**

  Open `http://172.16.11.188:8080` and `http://192.168.150.166:8080` (adjust port if different).
  Click Schedule tab on each. Confirm grid renders and add/edit/delete works.
