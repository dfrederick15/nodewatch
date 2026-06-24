/**
 * ami.ts — Asterisk Manager Interface (AMI) client
 *
 * The AMI is a plain-text TCP protocol on port 5038.
 * After login, you send "packets" of key: value lines terminated by \r\n\r\n.
 * Asterisk replies with similar packets.
 *
 * This module handles:
 *   - Opening a TCP socket with a connect timeout
 *   - Logging in and verifying authentication
 *   - Sending actions and reading back the matching response (by ActionID)
 *   - Read timeout so a hung Asterisk socket doesn't stall the server
 *   - Parsing XStat and SawStat responses into structured node data
 */

import * as net from "node:net";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NodeConn {
  node: string;
  ip: string;
  direction: string;   // "IN" | "OUT"
  elapsed: number;     // seconds connected
  link: string;        // "ESTABLISHED" | "CONNECTING"
  mode: string;        // "T" | "R" | "M" | "C" (transceive/receive/monitor/connecting)
  keyed: boolean;
  last_keyed: number;  // seconds ago, or -1 if never
  cos_keyed: boolean;  // carrier sense
  tx_keyed: boolean;   // PTT active
}

export interface NodeStatus {
  node: string;
  connections: NodeConn[];
  cos_keyed: boolean;
  tx_keyed: boolean;
  error?: string;
}

// ── AMI Client ────────────────────────────────────────────────────────────────

export class AMIClient {
  private host: string;
  private port: number;
  private connectTimeoutMs: number;
  private readTimeoutMs: number;

  constructor(
    hostWithOptionalPort: string,
    connectTimeoutS: number = 5,
    readTimeoutS: number = 5,
  ) {
    const parts = hostWithOptionalPort.split(":");
    this.host = parts[0];
    this.port = parts[1] ? parseInt(parts[1], 10) : 5038;
    this.connectTimeoutMs = connectTimeoutS * 1000;
    this.readTimeoutMs = readTimeoutS * 1000;
  }

  // Opens a socket and logs in. Returns the connected socket, or throws.
  async connect(user: string, password: string): Promise<net.Socket> {
    const socket = await this._openSocket();
    await this._login(socket, user, password);
    return socket;
  }

  // Runs an Asterisk CLI command and returns the raw output string.
  async command(socket: net.Socket, cmdString: string): Promise<string> {
    const actionID = "cmd_" + Math.random().toString(36).slice(2);
    const packet =
      `ACTION: COMMAND\r\n` +
      `COMMAND: ${cmdString}\r\n` +
      `ActionID: ${actionID}\r\n\r\n`;
    await this._write(socket, packet);
    return this._readResponse(socket, actionID);
  }

  // Sends an ilink command (connect/disconnect between nodes).
  //
  // ilink codes:
  //   1  — disconnect (soft, temporary)
  //   2  — monitor only (no TX)
  //   3  — connect (transceive)
  //   8  — local monitor only
  //  11  — disconnect (permanent)
  //  12  — permanent monitor
  //  13  — permanent connect
  //  18  — permanent local monitor
  async ilink(
    socket: net.Socket,
    localNode: string,
    remoteNode: string,
    code: number,
  ): Promise<string> {
    return this.command(socket, `rpt cmd ${localNode} ilink ${code} ${remoteNode}`);
  }

  // Sends DTMF digits to a node (runs as if typed on the radio).
  async dtmf(socket: net.Socket, localNode: string, digits: string): Promise<string> {
    return this.command(socket, `rpt fun ${localNode} ${digits}`);
  }

  // Fetches full node status: connected nodes, keyed state.
  async getNodeStatus(socket: net.Socket, node: string): Promise<NodeStatus> {
    const xstat = await this._rptStatus(socket, node, "XStat");
    const sawstat = await this._rptStatus(socket, node, "SawStat");
    return parseNodeStatus(node, xstat, sawstat);
  }

  // Closes the socket cleanly.
  close(socket: net.Socket): void {
    try {
      socket.write("ACTION: Logoff\r\n\r\n");
      socket.destroy();
    } catch (_) {
      // ignore errors on close
    }
  }

  // Like connect() but logs in with EVENTS: on so Asterisk pushes unsolicited
  // event packets (VerboseMessage, channel events, etc.) on the socket.
  async connectEvents(user: string, password: string): Promise<net.Socket> {
    const socket = await this._openSocket();
    await this._loginEvents(socket, user, password);
    return socket;
  }

  // Attaches a persistent data listener that parses incoming AMI event packets
  // and calls onEvent for each one. Returns a cleanup function.
  listenEvents(
    socket: net.Socket,
    onEvent: (fields: Record<string, string>) => void,
  ): () => void {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const packets = buffer.split("\r\n\r\n");
      buffer = packets.pop() ?? "";
      for (const pkt of packets) {
        if (pkt.trim()) onEvent(parseAmiPacket(pkt));
      }
    };
    socket.on("data", onData);
    return () => socket.removeListener("data", onData);
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private _openSocket(): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`AMI connect timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);

      socket.connect(this.port, this.host, () => {
        clearTimeout(timer);
        // Consume the AMI banner line (e.g. "Asterisk Call Manager/2.10.4")
        socket.once("data", () => resolve(socket));
      });

      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  private async _login(socket: net.Socket, user: string, password: string): Promise<void> {
    const actionID = "login_" + user;
    const packet =
      `ACTION: LOGIN\r\n` +
      `USERNAME: ${user}\r\n` +
      `SECRET: ${password}\r\n` +
      `EVENTS: 0\r\n` +
      `ActionID: ${actionID}\r\n\r\n`;
    await this._write(socket, packet);
    const response = await this._readResponse(socket, actionID);
    if (!response.includes("Authentication accepted")) {
      throw new Error("AMI login failed — check username and password in config.toml");
    }
  }

  private async _loginEvents(socket: net.Socket, user: string, password: string): Promise<void> {
    const actionID = "evlogin_" + user;
    const packet =
      `ACTION: LOGIN\r\n` +
      `USERNAME: ${user}\r\n` +
      `SECRET: ${password}\r\n` +
      `EVENTS: on\r\n` +
      `ActionID: ${actionID}\r\n\r\n`;
    await this._write(socket, packet);
    const response = await this._readResponse(socket, actionID);
    if (!response.includes("Authentication accepted")) {
      throw new Error("AMI event login failed — check username and password in config.toml");
    }
  }

  private _write(socket: net.Socket, data: string): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.write(data, "utf8", (err) => (err ? reject(err) : resolve()));
    });
  }

  // Reads lines from the socket until we see a packet containing our ActionID,
  // then returns that full packet. Rejects after readTimeoutMs.
  private _readResponse(socket: net.Socket, actionID: string): Promise<string> {
    return new Promise((resolve, reject) => {
      let buffer = "";
      let settled = false;

      const cleanup = () => {
        socket.removeListener("data", onData);
        socket.removeListener("error", onError);
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`AMI read timeout waiting for ActionID: ${actionID}`));
      }, this.readTimeoutMs);

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        // AMI packets are separated by \r\n\r\n
        const packets = buffer.split("\r\n\r\n");
        // Keep the last (possibly incomplete) chunk in buffer
        buffer = packets.pop() ?? "";

        for (const packet of packets) {
          if (packet.includes(`ActionID: ${actionID}`)) {
            settled = true;
            clearTimeout(timer);
            cleanup();
            resolve(packet);
            return;
          }
        }
      };

      const onError = (err: Error) => {
        clearTimeout(timer);
        cleanup();
        if (!settled) reject(err);
      };

      socket.on("data", onData);
      socket.on("error", onError);
    });
  }

  private async _rptStatus(socket: net.Socket, node: string, command: string): Promise<string> {
    const actionID = command.toLowerCase() + "_" + node + "_" + Math.random().toString(36).slice(2);
    const packet =
      `ACTION: RptStatus\r\n` +
      `COMMAND: ${command}\r\n` +
      `NODE: ${node}\r\n` +
      `ActionID: ${actionID}\r\n\r\n`;
    await this._write(socket, packet);
    return this._readResponse(socket, actionID);
  }
}

// ── Parsing ───────────────────────────────────────────────────────────────────

// Parses a raw AMI packet (CRLF-delimited "Key: Value" lines) into a flat map.
export function parseAmiPacket(packet: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of packet.split(/\r?\n/)) {
    const idx = line.indexOf(": ");
    if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 2);
  }
  return fields;
}

// AllStar XStat reports elapsed as either plain seconds or "H:MM:SS" / "MM:SS".
function parseElapsed(s: string | undefined): number {
  if (!s) return 0;
  const parts = s.split(":").map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function parseNodeStatus(node: string, xstat: string, sawstat: string): NodeStatus {
  const lines = xstat.split("\n");
  const sawLines = sawstat.split("\n");

  // Parse XStat Conn lines: node ip ? direction elapsed [link]
  const conns: Array<string[]> = [];
  let cosKeyed = false;
  let txKeyed = false;
  const modes: Record<string, string> = {};

  for (const line of lines) {
    const connMatch = line.match(/^Conn: (.+)/);
    if (connMatch) {
      const parts = connMatch[1].trim().split(/\s+/);
      // EchoLink nodes (>3000000) have no IP column
      if (/^\d+$/.test(parts[0]) && parseInt(parts[0]) > 3000000) {
        conns.push([parts[0], "", parts[1], parts[2], parts[3], parts[4] ?? ""]);
      } else {
        conns.push(parts);
      }
    }
    if (/RPT_RXKEYED=1/.test(line)) cosKeyed = true;
    if (/RPT_TXKEYED=1/.test(line)) txKeyed = true;

    const linkedMatch = line.match(/^LinkedNodes: (.+)/);
    if (linkedMatch) {
      for (const entry of linkedMatch[1].split(/, /)) {
        const modeChar = entry[0];
        const nodeNum = entry.slice(1);
        modes[nodeNum] = modeChar;
      }
    }
  }

  // Parse SawStat Conn lines: node isKeyed keyedSecsAgo unkeyedSecsAgo
  const keyups: Record<string, { isKeyed: boolean; keyed: number }> = {};
  for (const line of sawLines) {
    const m = line.match(/^Conn: (.+)/);
    if (m) {
      const parts = m[1].trim().split(/\s+/);
      keyups[parts[0]] = {
        isKeyed: parts[1] === "1",
        keyed: parseInt(parts[2], 10),
      };
    }
  }

  // Build connection list
  const connections: NodeConn[] = [];
  for (const parts of conns) {
    const n = parts[0];
    let direction = parts[3] ?? "";
    let elapsed = parseElapsed(parts[4]);
    let link = parts[5] ?? "";

    // Shorter IRLP/EchoLink format has fewer columns
    if (!link) {
      direction = parts[2] ?? "";
      elapsed = parseElapsed(parts[3]);
      if (modes[n]) {
        link = modes[n] === "C" ? "CONNECTING" : "ESTABLISHED";
      }
    }

    const keyup = keyups[n];
    connections.push({
      node: n,
      ip: parts[1] ?? "",
      direction,
      elapsed,
      link,
      mode: modes[n] ?? "M",
      keyed: keyup?.isKeyed ?? false,
      last_keyed: keyup ? keyup.keyed : -1,
      cos_keyed: cosKeyed,
      tx_keyed: txKeyed,
    });
  }

  return { node, connections, cos_keyed: cosKeyed, tx_keyed: txKeyed };
}
