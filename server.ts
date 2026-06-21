/**
 * server.ts — AllStar Node Monitor
 *
 * Run:  npm start   (node --experimental-strip-types server.ts)
 *
 * What this does:
 *  1. Reads config.toml for all settings.
 *  2. Optionally reads the AllStar node database (astdb.txt) for callsign/location lookups.
 *  3. Maintains one persistent AMI connection per Asterisk host; reconnects on drop.
 *  4. Polls each node on the configured interval and pushes changes via SSE.
 *  5. Fetches what each connected remote node is itself connected to (subnodes)
 *     from the AllStar stats API — cached, non-blocking.
 *  6. Exposes a small REST API for connect/disconnect/DTMF/command actions.
 *  7. Session-based auth via HttpOnly cookie — no database needed.
 */

import * as http from "node:http";
import * as fs   from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { AMIClient, type NodeStatus, type NodeConn } from "./ami.ts";

// ── Config ────────────────────────────────────────────────────────────────────

interface NodeConfig {
  node: number;
  host: string;
  user: string;
  password: string;
  label?: string;
  private?: boolean;
  stream_url?: string;
  website_url?: string;
}

interface Config {
  server: {
    port: number;
    host: string;
    poll_interval_ms: number;
    ami_connect_timeout_s: number;
    ami_read_timeout_s: number;
  };
  auth: {
    username: string;
    password: string;
    session_timeout_s: number;
  };
  display: {
    callsign: string;
    title: string;
    location: string;
    max_nodes: number;
    show_never_heard: boolean;
    timezone: string;
  };
  nodes: NodeConfig[];
  commands: { label: string; command: string }[];
  favorites?: { nodes: number[] };
}

const configPath = new URL("./config.toml", import.meta.url).pathname;
let cfg: Config;
try {
  cfg = parseToml(fs.readFileSync(configPath, "utf8")) as unknown as Config;
} catch (err) {
  console.error("Failed to read config.toml:", err);
  process.exit(1);
}

// ── Config serializer ─────────────────────────────────────────────────────────
// Converts the in-memory config back to TOML. Comments are not preserved —
// this is intentional when saving via the settings UI.

function tomlStr(v: string): string {
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function serializeConfig(c: Config): string {
  const L: string[] = [
    "# AllStar Node Monitor — Configuration",
    "# Saved by nodewatch settings panel. Restart to apply changes.",
    "",
    "[server]",
    `port                 = ${c.server.port}`,
    `host                 = ${tomlStr(c.server.host)}`,
    `poll_interval_ms     = ${c.server.poll_interval_ms}`,
    `ami_connect_timeout_s = ${c.server.ami_connect_timeout_s}`,
    `ami_read_timeout_s   = ${c.server.ami_read_timeout_s}`,
    "",
    "[auth]",
    `username         = ${tomlStr(c.auth.username)}`,
    `password         = ${tomlStr(c.auth.password)}`,
    `session_timeout_s = ${c.auth.session_timeout_s}`,
    "",
    "[display]",
    `callsign         = ${tomlStr(c.display.callsign)}`,
    `title            = ${tomlStr(c.display.title)}`,
    `location         = ${tomlStr(c.display.location ?? "")}`,
    `max_nodes        = ${c.display.max_nodes ?? 0}`,
    `show_never_heard = ${c.display.show_never_heard ?? true}`,
    `timezone         = ${tomlStr(c.display.timezone ?? "America/New_York")}`,
    "",
    "[favorites]",
    `nodes = [${(c.favorites?.nodes ?? []).join(", ")}]`,
    "",
  ];
  for (const n of c.nodes ?? []) {
    L.push("[[nodes]]");
    L.push(`node        = ${Number(n.node)}`);
    L.push(`host        = ${tomlStr(n.host)}`);
    L.push(`user        = ${tomlStr(n.user)}`);
    L.push(`password    = ${tomlStr(n.password)}`);
    L.push(`label       = ${tomlStr(n.label ?? "")}`);
    L.push(`private     = ${n.private ?? false}`);
    L.push(`stream_url  = ${tomlStr(n.stream_url ?? "")}`);
    L.push(`website_url = ${tomlStr(n.website_url ?? "")}`);
    L.push("");
  }
  for (const cmd of c.commands ?? []) {
    L.push("[[commands]]");
    L.push(`label   = ${tomlStr(cmd.label)}`);
    L.push(`command = ${tomlStr(cmd.command)}`);
    L.push("");
  }
  return L.join("\n");
}

// ── AllStar node database (astdb.txt) ─────────────────────────────────────────
// Maps node number → "CALLSIGN City, State"
// The astdb.txt file is maintained by AllStar and contains public node info.
// Common paths: /var/www/html/allmon3/astdb.txt  or  /var/lib/asterisk/astdb.txt
// If the file isn't found, node info just shows the IP or stays blank.

const astdb = new Map<string, string>();
const ASTDB_PATHS = [
  "/var/www/html/allmon3/astdb.txt",
  "/var/www/html/supermon/astdb.txt",
  "/var/lib/asterisk/astdb.txt",
];

function loadAstdb(): void {
  for (const p of ASTDB_PATHS) {
    if (!fs.existsSync(p)) continue;
    try {
      const lines = fs.readFileSync(p, "utf8").split("\n");
      for (const line of lines) {
        const parts = line.split("|");
        if (parts.length >= 4) {
          const info = [parts[1], parts[2], parts[3]].filter(Boolean).join(" ").trim();
          astdb.set(parts[0].trim(), info);
        }
      }
      console.log(`Loaded ${astdb.size} nodes from ${p}`);
      return;
    } catch (_) {}
  }
}
loadAstdb();

function nodeInfo(nodeNum: string): string {
  return astdb.get(nodeNum) ?? "";
}

// ── Subnode cache ─────────────────────────────────────────────────────────────
// For each remote node connected to us, we fetch what IT is connected to
// from the AllStar stats API. Results are cached for SUBNODE_TTL ms.

interface SubnodeEntry {
  node: string;
  info: string;
}

interface SubnodeCacheEntry {
  subnodes: SubnodeEntry[];
  fetchedAt: number;
}

const subnodeCache = new Map<string, SubnodeCacheEntry>();
const SUBNODE_TTL = 60_000; // 60 seconds

// Parse an AllStar stats API response into a flat list of connected node entries.
// Endpoint: https://stats.allstarlink.org/api/stats/{node}
// Response shape: { stats: { data: { linkedNodes: [ { name: number, callsign: string,
//   node_frequency: string, server: { Location: string } } ] } } }
function parseStatsResponse(data: Record<string, unknown>, selfNode: string): SubnodeEntry[] {
  const stats = data.stats as Record<string, unknown> | undefined;
  const inner = stats?.data as Record<string, unknown> | undefined;
  const linked = (inner?.linkedNodes ?? []) as Array<Record<string, unknown>>;
  const entries: SubnodeEntry[] = [];
  for (const conn of linked) {
    const n = String(conn.name ?? "").trim();
    if (!n || n === selfNode) continue;
    // Prefer astdb for consistent display; fall back to API callsign + location.
    const apiInfo = [
      String(conn.callsign ?? "").trim(),
      String((conn.server as Record<string,unknown>)?.Location ?? conn.node_frequency ?? "").trim(),
    ].filter(Boolean).join(" — ");
    entries.push({ node: n, info: nodeInfo(n) || apiInfo });
  }
  return entries;
}

async function fetchSubnodes(nodeNum: string): Promise<SubnodeEntry[]> {
  const cached = subnodeCache.get(nodeNum);
  if (cached && Date.now() - cached.fetchedAt < SUBNODE_TTL) return cached.subnodes;

  try {
    const url = `https://stats.allstarlink.org/api/stats/${nodeNum}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { "User-Agent": "nodewatch/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as Record<string, unknown>;
    const subnodes = parseStatsResponse(data, nodeNum);
    subnodeCache.set(nodeNum, { subnodes, fetchedAt: Date.now() });
    return subnodes;
  } catch (_) {
    return [];
  }
}

// ── Session store ─────────────────────────────────────────────────────────────

interface Session { username: string; expires: number; }
const sessions = new Map<string, Session>();

function createSession(username: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { username, expires: Date.now() + cfg.auth.session_timeout_s * 1000 });
  return token;
}

function getSession(token: string | undefined): Session | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k) out[k.trim()] = decodeURIComponent(rest.join("=").trim());
  }
  return out;
}

function sessionFromReq(req: http.IncomingMessage): Session | null {
  return getSession(parseCookies(req.headers.cookie)["asl_session"]);
}

// ── AMI connection pool ───────────────────────────────────────────────────────

interface HostConn {
  socket: import("node:net").Socket | null;
  client: AMIClient;
  nodeCfg: NodeConfig;
}
const hostConns = new Map<string, HostConn>();

async function ensureConnected(nodeCfg: NodeConfig): Promise<HostConn> {
  const key = nodeCfg.host;
  let conn = hostConns.get(key);
  if (!conn) {
    const client = new AMIClient(nodeCfg.host, cfg.server.ami_connect_timeout_s, cfg.server.ami_read_timeout_s);
    conn = { socket: null, client, nodeCfg };
    hostConns.set(key, conn);
  }
  if (!conn.socket || conn.socket.destroyed) {
    try {
      conn.socket = await conn.client.connect(nodeCfg.user, nodeCfg.password);
      conn.socket.on("error", () => { conn!.socket = null; });
      conn.socket.on("close",  () => { conn!.socket = null; });
      console.log(`AMI connected: ${key} (node ${nodeCfg.node})`);
    } catch (err) {
      conn.socket = null;
      throw err;
    }
  }
  return conn;
}

// ── SSE broadcaster ───────────────────────────────────────────────────────────

interface SSEClient { res: http.ServerResponse; }
const sseClients = new Set<SSEClient>();

function sseWrite(client: SSEClient, event: string, data: unknown): void {
  try { client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
  catch (_) { sseClients.delete(client); }
}

function broadcast(event: string, data: unknown): void {
  for (const c of sseClients) sseWrite(c, event, data);
}

// ── Extended status type (status + subnodes + info) ───────────────────────────

export interface NodeConnFull extends NodeConn {
  info: string;
  subnodes: SubnodeEntry[];
}

export interface NodeStatusFull {
  node: string;
  cos_keyed: boolean;
  tx_keyed: boolean;
  connections: NodeConnFull[];
  error?: string;
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

const lastStatus = new Map<string, NodeStatusFull>();

async function pollNodes(): Promise<void> {
  for (const nodeCfg of cfg.nodes) {
    const nodeStr = String(nodeCfg.node);
    try {
      const conn = await ensureConnected(nodeCfg);
      if (!conn.socket) continue;

      const status = await conn.client.getNodeStatus(conn.socket, nodeStr);

      // Enrich connections with info from astdb and subnodes from stats API
      const connsFull: NodeConnFull[] = await Promise.all(
        status.connections.map(async (c) => {
          const subnodes = c.node !== "1" ? await fetchSubnodes(c.node) : [];
          return { ...c, info: nodeInfo(c.node), subnodes };
        })
      );

      const full: NodeStatusFull = {
        node: status.node,
        cos_keyed: status.cos_keyed,
        tx_keyed: status.tx_keyed,
        connections: connsFull,
      };

      // Push full status only when something changed
      const prev = JSON.stringify(lastStatus.get(nodeStr));
      const curr = JSON.stringify(full);
      if (prev !== curr) {
        lastStatus.set(nodeStr, full);
        broadcast("node_status", full);
      }

      // Always push timing so clients can tick their live counters
      broadcast("node_times", {
        node: nodeStr,
        connections: connsFull.map((c) => ({
          node: c.node,
          elapsed: c.elapsed,
          last_keyed: c.last_keyed,
        })),
      });
    } catch (err) {
      broadcast("node_error", { node: nodeStr, error: (err as Error).message });
    }
  }
}

setInterval(pollNodes, cfg.server.poll_interval_ms);
pollNodes();

// ── Static file server ────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".ico": "image/x-icon",
  ".png": "image/png", ".svg": "image/svg+xml",
};
const publicDir = new URL("./public", import.meta.url).pathname;

function serveStatic(res: http.ServerResponse, filePath: string): void {
  const mime = MIME[path.extname(filePath)] ?? "application/octet-stream";
  try {
    res.writeHead(200, { "Content-Type": mime });
    res.end(fs.readFileSync(filePath));
  } catch (_) { res.writeHead(404); res.end("Not found"); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try { resolve(JSON.parse(raw)); }
      catch (_) {
        const p = new URLSearchParams(raw);
        const o: Record<string, string> = {};
        p.forEach((v, k) => (o[k] = v));
        resolve(o);
      }
    });
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): Session | null {
  const s = sessionFromReq(req);
  if (!s) { json(res, 401, { error: "Not logged in" }); return null; }
  return s;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url      = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // ── Auth ──────────────────────────────────────────────────────────────────

  if (pathname === "/api/login" && req.method === "POST") {
    const body = await readBody(req);
    if (body.username === cfg.auth.username && body.password === cfg.auth.password) {
      const token = createSession(body.username);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `asl_session=${token}; HttpOnly; Path=/; SameSite=Lax`,
      });
      res.end(JSON.stringify({ ok: true }));
    } else {
      json(res, 401, { error: "Invalid credentials" });
    }
    return;
  }

  if (pathname === "/api/logout" && req.method === "POST") {
    const token = parseCookies(req.headers.cookie)["asl_session"];
    if (token) sessions.delete(token);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "asl_session=; HttpOnly; Path=/; Max-Age=0",
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Public read-only endpoints ────────────────────────────────────────────

  if (pathname === "/api/session") {
    const s = sessionFromReq(req);
    json(res, 200, { logged_in: !!s, username: s?.username ?? null });
    return;
  }

  if (pathname === "/api/config") {
    json(res, 200, {
      display: cfg.display,
      nodes: cfg.nodes.map((n) => ({
        node: n.node, label: n.label ?? "", private: n.private ?? false,
        stream_url: n.stream_url ?? "", website_url: n.website_url ?? "",
      })),
      commands: cfg.commands,
    });
    return;
  }

  // ── Favorites status (public) ─────────────────────────────────────────────
  // Returns live data for each node in cfg.favorites.nodes by querying the
  // AllStar stats API. Results are not cached here — the client polls at its
  // own preferred interval (typically 30 s).

  if (pathname === "/api/favorites/status" && req.method === "GET") {
    const favNums = cfg.favorites?.nodes ?? [];
    const results = await Promise.all(
      favNums.map(async (nodeNum: number) => {
        const n   = String(nodeNum);
        const inf = nodeInfo(n);
        try {
          const apiRes = await fetch(`https://stats.allstarlink.org/api/stats/${n}`, {
            signal: AbortSignal.timeout(5000),
            headers: { "User-Agent": "nodewatch/1.0" },
          });
          if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status}`);
          const data  = await apiRes.json() as Record<string, unknown>;
            const stats  = data.stats as Record<string, unknown> | undefined;
          const inner  = stats?.data as Record<string, unknown> | undefined;
          const linked = (inner?.linkedNodes ?? []) as Array<Record<string, unknown>>;
          const keyed  = !!(inner?.keyed ?? false);
          const connNodes = linked.map(c => String(c.name ?? "").trim()).filter(Boolean);
          const apiCallsign = String(linked[0]?.callsign ?? "").trim();
          return {
            node: n,
            info: inf || apiCallsign,
            keyed,
            connection_count: connNodes.length,
            connections: connNodes.slice(0, 8).map((cn) => ({ node: cn, info: nodeInfo(cn) })),
            status: "online",
          };
        } catch (_) {
          return { node: n, info: inf, keyed: false, connection_count: 0, connections: [], status: "offline" };
        }
      })
    );
    json(res, 200, results);
    return;
  }

  // ── Settings (auth required) ──────────────────────────────────────────────

  if (pathname === "/api/settings" && req.method === "GET") {
    if (!requireAuth(req, res)) return;
    json(res, 200, cfg);
    return;
  }

  // ── SSE stream ────────────────────────────────────────────────────────────

  if (pathname === "/api/sse") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });
    // Send current known state immediately so page isn't blank on load
    for (const status of lastStatus.values()) {
      res.write(`event: node_status\ndata: ${JSON.stringify(status)}\n\n`);
    }
    const client: SSEClient = { res };
    sseClients.add(client);
    req.on("close", () => sseClients.delete(client));
    return;
  }

  // ── Authenticated action endpoints ────────────────────────────────────────

  if (pathname.startsWith("/api/") && req.method === "POST") {

    // Settings save — write config.toml and restart the process so systemd
    // picks up the new file. A backup is written first.
    if (pathname === "/api/settings") {
      if (!requireAuth(req, res)) return;
      const newCfg = await readBody(req) as unknown as Config;
      if (!newCfg?.server || !newCfg?.auth || !newCfg?.display || !Array.isArray(newCfg?.nodes)) {
        json(res, 400, { error: "Invalid config structure" }); return;
      }
      if (fs.existsSync(configPath)) fs.copyFileSync(configPath, configPath + ".bak");
      fs.writeFileSync(configPath, serializeConfig(newCfg), "utf8");
      json(res, 200, { ok: true, message: "Config saved. Server restarting…" });
      setTimeout(() => process.exit(0), 500);
      return;
    }

    // Favorites add / remove — update cfg in memory AND rewrite config.toml.
    // No restart needed; the favorites list is read fresh on each /api/favorites/status call.
    if (pathname === "/api/favorites/add" || pathname === "/api/favorites/remove") {
      if (!requireAuth(req, res)) return;
      const body = await readBody(req);
      const node = parseInt(String(body.node));
      if (isNaN(node)) { json(res, 400, { error: "Invalid node number" }); return; }
      if (!cfg.favorites) cfg.favorites = { nodes: [] };
      if (pathname === "/api/favorites/add") {
        if (!cfg.favorites.nodes.includes(node)) cfg.favorites.nodes.push(node);
      } else {
        cfg.favorites.nodes = cfg.favorites.nodes.filter((n) => n !== node);
      }
      fs.writeFileSync(configPath, serializeConfig(cfg), "utf8");
      json(res, 200, { ok: true, nodes: cfg.favorites.nodes });
      return;
    }

    if (!requireAuth(req, res)) return;
    const body = await readBody(req);

    const localNode = body.local_node;
    if (!localNode) { json(res, 400, { error: "local_node is required" }); return; }

    const nodeCfg = cfg.nodes.find((n) => String(n.node) === localNode);
    if (!nodeCfg) { json(res, 400, { error: `Node ${localNode} not in config.toml` }); return; }

    if (pathname === "/api/connect") {
      const remoteNode = body.remote_node;
      const mode      = body.mode ?? "connect";
      const permanent = body.permanent === "true";
      if (!remoteNode) { json(res, 400, { error: "remote_node is required" }); return; }
      // ilink codes: connect=3/13  monitor=2/12  localmonitor=8/18
      const codes: Record<string, [number, number]> = {
        connect: [3, 13], monitor: [2, 12], localmonitor: [8, 18],
      };
      const [temp, perm] = codes[mode] ?? codes.connect;
      try {
        const conn = await ensureConnected(nodeCfg);
        await conn.client.ilink(conn.socket!, localNode, remoteNode, permanent ? perm : temp);
        json(res, 200, { ok: true, message: `${mode} ${localNode} → ${remoteNode}` });
      } catch (err) { json(res, 500, { error: String(err) }); }
      return;
    }

    if (pathname === "/api/disconnect") {
      const remoteNode = body.remote_node;
      const permanent  = body.permanent === "true";
      if (!remoteNode) { json(res, 400, { error: "remote_node is required" }); return; }
      // ilink 1 = temporary disconnect, 11 = permanent
      try {
        const conn = await ensureConnected(nodeCfg);
        await conn.client.ilink(conn.socket!, localNode, remoteNode, permanent ? 11 : 1);
        json(res, 200, { ok: true, message: `disconnect ${localNode} ↔ ${remoteNode}` });
      } catch (err) { json(res, 500, { error: String(err) }); }
      return;
    }

    if (pathname === "/api/dtmf") {
      const digits = body.digits;
      if (!digits) { json(res, 400, { error: "digits is required" }); return; }
      try {
        const conn = await ensureConnected(nodeCfg);
        await conn.client.dtmf(conn.socket!, localNode, digits);
        json(res, 200, { ok: true, message: `DTMF ${digits} → node ${localNode}` });
      } catch (err) { json(res, 500, { error: String(err) }); }
      return;
    }

    if (pathname === "/api/command") {
      const cmdTemplate = body.command;
      if (!cmdTemplate) { json(res, 400, { error: "command is required" }); return; }
      // Whitelist: command must be in config.toml [[commands]]
      const allowed = cfg.commands.find((c) => c.command === cmdTemplate);
      if (!allowed) { json(res, 403, { error: "Command not in config.toml [[commands]] list" }); return; }
      const cmdString = cmdTemplate.replace(/%node%/g, localNode);
      try {
        const conn = await ensureConnected(nodeCfg);
        const output = await conn.client.command(conn.socket!, cmdString);
        json(res, 200, { ok: true, output });
      } catch (err) { json(res, 500, { error: String(err) }); }
      return;
    }

    json(res, 404, { error: "Unknown endpoint" });
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────

  const filePath = path.join(publicDir, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(publicDir)) { res.writeHead(403); res.end("Forbidden"); return; }
  serveStatic(res, filePath);
});

server.listen(cfg.server.port, cfg.server.host, () => {
  console.log(`AllStar Monitor running at http://${cfg.server.host}:${cfg.server.port}`);
  console.log(`Monitoring ${cfg.nodes.length} node(s): ${cfg.nodes.map((n) => n.node).join(", ")}`);
});
