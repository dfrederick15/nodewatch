/**
 * server.ts — AllStar Node Monitor web server
 *
 * Run with:  npm start
 *            (requires Node.js >= 22.6 for --experimental-strip-types)
 *
 * What this does:
 *   1. Reads config.toml for all settings and node definitions.
 *   2. Serves the static UI from ./public/
 *   3. Opens a persistent AMI connection to each configured Asterisk server
 *      and polls node status on the configured interval.
 *   4. Pushes status updates to browsers via Server-Sent Events (SSE).
 *   5. Exposes a small REST API for connect/disconnect/DTMF/command actions.
 *   6. Handles session-based authentication (cookie, no database needed).
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { AMIClient, type NodeStatus } from "./ami.ts";

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

interface CommandConfig {
  label: string;
  command: string;
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
  commands: CommandConfig[];
}

const configPath = new URL("./config.toml", import.meta.url).pathname;
let cfg: Config;
try {
  cfg = parseToml(fs.readFileSync(configPath, "utf8")) as unknown as Config;
} catch (err) {
  console.error("Failed to read config.toml:", err);
  process.exit(1);
}

// ── Session store ─────────────────────────────────────────────────────────────
// Sessions are stored in memory — they clear on server restart (intentional).

interface Session {
  username: string;
  expires: number;
}

const sessions = new Map<string, Session>();

function createSession(username: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, {
    username,
    expires: Date.now() + cfg.auth.session_timeout_s * 1000,
  });
  return token;
}

function getSession(token: string | undefined): Session | null {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) {
    sessions.delete(token);
    return null;
  }
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
// One persistent AMI socket per unique Asterisk host.
// If a socket disconnects, it is re-established on the next poll cycle.

interface HostConn {
  socket: import("node:net").Socket | null;
  client: AMIClient;
  nodeConfig: NodeConfig; // first node config that uses this host
}

const hostConns = new Map<string, HostConn>();

async function ensureConnected(nodeCfg: NodeConfig): Promise<HostConn> {
  const key = nodeCfg.host;
  let conn = hostConns.get(key);

  if (!conn) {
    const client = new AMIClient(
      nodeCfg.host,
      cfg.server.ami_connect_timeout_s,
      cfg.server.ami_read_timeout_s,
    );
    conn = { socket: null, client, nodeConfig: nodeCfg };
    hostConns.set(key, conn);
  }

  if (!conn.socket || conn.socket.destroyed) {
    try {
      conn.socket = await conn.client.connect(nodeCfg.user, nodeCfg.password);
      conn.socket.on("error", () => {
        conn!.socket = null;
      });
      conn.socket.on("close", () => {
        conn!.socket = null;
      });
      console.log(`AMI connected: ${key} (node ${nodeCfg.node})`);
    } catch (err) {
      conn.socket = null;
      throw err;
    }
  }

  return conn;
}

// ── SSE broadcaster ───────────────────────────────────────────────────────────

interface SSEClient {
  res: http.ServerResponse;
  nodeNumbers: string[];
}

const sseClients: Set<SSEClient> = new Set();

function sseWrite(client: SSEClient, event: string, data: unknown): void {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {
    sseClients.delete(client);
  }
}

function broadcastAll(event: string, data: unknown): void {
  for (const client of sseClients) {
    sseWrite(client, event, data);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

const lastStatus = new Map<string, NodeStatus>();

async function pollNodes(): Promise<void> {
  for (const nodeCfg of cfg.nodes) {
    const nodeStr = String(nodeCfg.node);
    try {
      const conn = await ensureConnected(nodeCfg);
      if (!conn.socket) continue;

      const status = await conn.client.getNodeStatus(conn.socket, nodeStr);

      // Only push to SSE clients if something changed
      const prev = JSON.stringify(lastStatus.get(nodeStr));
      const curr = JSON.stringify(status);
      if (prev !== curr) {
        lastStatus.set(nodeStr, status);
        broadcastAll("node_status", status);
      }

      // Always send timing updates (elapsed / last_keyed counters)
      broadcastAll("node_times", {
        node: nodeStr,
        connections: status.connections.map((c) => ({
          node: c.node,
          elapsed: c.elapsed,
          last_keyed: c.last_keyed,
        })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      broadcastAll("node_error", { node: nodeStr, error: msg });
    }
  }
}

setInterval(pollNodes, cfg.server.poll_interval_ms);
// Run immediately on start too
pollNodes();

// ── Static file server ────────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function serveStatic(res: http.ServerResponse, filePath: string): void {
  const ext = path.extname(filePath);
  const mime = MIME[ext] ?? "application/octet-stream";
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(data);
  } catch (_) {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ── Request body helper ───────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        // Try URL-encoded form data
        const params = new URLSearchParams(raw);
        const out: Record<string, string> = {};
        params.forEach((v, k) => (out[k] = v));
        resolve(out);
      }
    });
  });
}

// ── JSON response helpers ──────────────────────────────────────────────────────

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function requireAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Session | null {
  const session = sessionFromReq(req);
  if (!session) {
    json(res, 401, { error: "Not logged in" });
    return null;
  }
  return session;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const publicDir = new URL("./public", import.meta.url).pathname;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const pathname = url.pathname;

  // ── Auth endpoints ─────────────────────────────────────────────────────

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
      "Set-Cookie": `asl_session=; HttpOnly; Path=/; Max-Age=0`,
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Config endpoint (read-only, no secrets) ────────────────────────────

  if (pathname === "/api/config") {
    json(res, 200, {
      display: cfg.display,
      nodes: cfg.nodes.map((n) => ({
        node: n.node,
        label: n.label ?? "",
        private: n.private ?? false,
        stream_url: n.stream_url ?? "",
        website_url: n.website_url ?? "",
      })),
      commands: cfg.commands,
    });
    return;
  }

  // ── Session status ─────────────────────────────────────────────────────

  if (pathname === "/api/session") {
    const session = sessionFromReq(req);
    json(res, 200, { logged_in: !!session, username: session?.username ?? null });
    return;
  }

  // ── SSE stream ─────────────────────────────────────────────────────────

  if (pathname === "/api/sse") {
    const nodeParam = url.searchParams.get("nodes") ?? "";
    const nodeNumbers = nodeParam.split(",").filter(Boolean);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    });

    // Send current known status immediately so the page isn't blank
    for (const [nodeStr, status] of lastStatus) {
      if (nodeNumbers.length === 0 || nodeNumbers.includes(nodeStr)) {
        res.write(`event: node_status\ndata: ${JSON.stringify(status)}\n\n`);
      }
    }

    const client: SSEClient = { res, nodeNumbers };
    sseClients.add(client);

    req.on("close", () => sseClients.delete(client));
    return;
  }

  // All API routes below require authentication
  if (pathname.startsWith("/api/") && req.method === "POST") {
    const session = requireAuth(req, res);
    if (!session) return;
    const body = await readBody(req);

    const localNode = body.local_node;
    if (!localNode) {
      json(res, 400, { error: "local_node is required" });
      return;
    }

    const nodeCfg = cfg.nodes.find((n) => String(n.node) === localNode);
    if (!nodeCfg) {
      json(res, 400, { error: `Node ${localNode} not in config.toml` });
      return;
    }

    // ── Connect ──────────────────────────────────────────────────────────

    if (pathname === "/api/connect") {
      // mode options: "connect" | "monitor" | "localmonitor"
      // permanent: "true" | "false"
      const remoteNode = body.remote_node;
      const mode = body.mode ?? "connect";
      const permanent = body.permanent === "true";

      if (!remoteNode) {
        json(res, 400, { error: "remote_node is required" });
        return;
      }

      // ilink codes:
      //  3=connect  13=permanent-connect
      //  2=monitor  12=permanent-monitor
      //  8=local-monitor  18=permanent-local-monitor
      const codes: Record<string, [number, number]> = {
        connect:      [3,  13],
        monitor:      [2,  12],
        localmonitor: [8,  18],
      };
      const pair = codes[mode] ?? codes.connect;
      const code = permanent ? pair[1] : pair[0];

      try {
        const conn = await ensureConnected(nodeCfg);
        await conn.client.ilink(conn.socket!, localNode, remoteNode, code);
        json(res, 200, { ok: true, message: `${mode} ${localNode} → ${remoteNode}` });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Disconnect ───────────────────────────────────────────────────────

    if (pathname === "/api/disconnect") {
      const remoteNode = body.remote_node;
      const permanent = body.permanent === "true";
      if (!remoteNode) {
        json(res, 400, { error: "remote_node is required" });
        return;
      }
      // ilink 1 = temporary disconnect, ilink 11 = permanent disconnect
      const code = permanent ? 11 : 1;
      try {
        const conn = await ensureConnected(nodeCfg);
        await conn.client.ilink(conn.socket!, localNode, remoteNode, code);
        json(res, 200, { ok: true, message: `disconnect ${localNode} ↔ ${remoteNode}` });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── DTMF ─────────────────────────────────────────────────────────────

    if (pathname === "/api/dtmf") {
      const digits = body.digits;
      if (!digits) {
        json(res, 400, { error: "digits is required" });
        return;
      }
      try {
        const conn = await ensureConnected(nodeCfg);
        await conn.client.dtmf(conn.socket!, localNode, digits);
        json(res, 200, { ok: true, message: `DTMF ${digits} → node ${localNode}` });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }

    // ── Control panel command ─────────────────────────────────────────────

    if (pathname === "/api/command") {
      const cmdTemplate = body.command;
      if (!cmdTemplate) {
        json(res, 400, { error: "command is required" });
        return;
      }
      // Validate the command is in the config (prevents arbitrary command injection)
      const allowed = cfg.commands.find((c) => c.command === cmdTemplate);
      if (!allowed) {
        json(res, 403, { error: "Command not in config.toml [[commands]] list" });
        return;
      }
      const cmdString = cmdTemplate.replace(/%node%/g, localNode);
      try {
        const conn = await ensureConnected(nodeCfg);
        const output = await conn.client.command(conn.socket!, cmdString);
        json(res, 200, { ok: true, output });
      } catch (err) {
        json(res, 500, { error: String(err) });
      }
      return;
    }

    json(res, 404, { error: "Unknown API endpoint" });
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────

  let filePath = path.join(publicDir, pathname === "/" ? "index.html" : pathname);
  // Security: don't serve files outside of publicDir
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  serveStatic(res, filePath);
});

server.listen(cfg.server.port, cfg.server.host, () => {
  console.log(`AllStar Monitor running at http://${cfg.server.host}:${cfg.server.port}`);
  console.log(`Monitoring ${cfg.nodes.length} node(s): ${cfg.nodes.map((n) => n.node).join(", ")}`);
});
