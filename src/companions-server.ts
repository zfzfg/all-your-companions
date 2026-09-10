/**
 * AP-16 — the host half of the companion-subagent delegation channel.
 *
 * The same architecture AP-05 uses, and for the same unavoidable reason: ACP
 * hands MCP servers to the CLI as a **stdio spec** only, and the CLI — not this
 * process — spawns and owns that child's stdin/stdout. So the extension host
 * cannot register itself as an MCP server. It ships a small script, lets the
 * CLI start it, and keeps a second channel open for the script to talk back on:
 *
 * ```
 * CLI ──spawn──► companions-server.cjs ──pipe / unix socket──► this file ──► spawn a child session
 *       stdio          (MCP JSON-RPC)       (NDJSON + token)      (sidebar)
 * ```
 *
 * **v1 opens a SECOND listener.** §6.4.1: `ask-user-server.ts` is
 * question-shaped — one outstanding request settled by a human — and this one is
 * call-shaped, with several long-running children per session. Multiplexing both
 * protocols onto one pipe is P6, and refactoring the ask-user settle paths is
 * explicitly not part of P2.
 *
 * **Every exit path cancels.** A call dropped without a reply leaves the CLI
 * blocked inside `tools/call` for ever — no timeout, no error, just a run that
 * never continues. Session restart, socket death, window reload, extension
 * deactivation and parent Stop all funnel into `settle()`, and the children
 * those calls started are cancelled with them.
 */
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { AcpMcpStdioServer } from "./mcp-connectors";
import {
  COMPANIONS_ADDRESS_ENV,
  COMPANIONS_IPC_VERSION,
  COMPANIONS_PRIMER,
  COMPANIONS_SERVER_NAME,
  COMPANIONS_TOOLS,
  COMPANIONS_TOKEN_ENV,
  checkHello,
  encodeFrame,
  parseClientFrame,
} from "./companions-protocol";
import { GENERATOR_PRIMER, GENERATOR_TOOLS } from "./workflow-generator";

export type CompanionsTokenMode = "delegate" | "generator";

/** One live tool call, as the sidebar sees it. */
export interface CompanionsCall {
  /** Host-unique id, namespaced by token — two sessions both start at 1. */
  id: string;
  /** Which of the three tools was called. */
  tool: string;
  /** Raw arguments. The handler normalizes them; nothing here trusts them. */
  args: unknown;
  /** Deliver a result. Returns false if this call was already settled. */
  resolve(payload: unknown): boolean;
  /** Deliver a failure the model should read as "the host could not answer". */
  fail(message: string): boolean;
  /** Still waiting for an answer. A handler polls this before doing more work. */
  readonly open: boolean;
}

export interface CompanionsServerOptions {
  /** Absolute path to the shipped `resources/mcp/companions-server.cjs`. */
  scriptPath: string;
  /** A tool call arrived on a registered token. Answer it via the call object. */
  onCall(token: string, call: CompanionsCall): void;
  /**
   * The call went away before it was answered (the CLI died, the socket
   * dropped, the session was revoked). Cancel whatever it started.
   */
  onAbandon(token: string, id: string): void;
  log(message: string): void;
  /** Node to run the script with. Defaults to this process — see `spawnSpec`. */
  nodePath?: string;
  /** Injected in tests. Defaults to `crypto.randomUUID`. */
  uuid?: () => string;
  /** Injected in tests. Defaults to a 256-bit `randomBytes` hex string. */
  mintToken?: () => string;
}

interface Outstanding {
  token: string;
  socket: net.Socket;
  /** The id the CLIENT used, which is what the result frame must carry back. */
  clientId: string;
  /** Settle exactly once; the second call is a no-op by construction. */
  settled: boolean;
}

/**
 * A pipe address that is legal on this platform.
 *
 * Windows named pipes are not files: they live in a flat kernel namespace under
 * `\\.\pipe\`, have no directory and no ACL we set here. POSIX gets a real
 * socket file in the per-user temp dir, where the 0700 tmpdir is a second
 * barrier the token does not need to be. Distinct from AP-05's address so the
 * two listeners cannot collide.
 */
export function companionsPipeAddress(
  id: string,
  platform: NodeJS.Platform = process.platform,
  tmp = os.tmpdir(),
): string {
  return platform === "win32"
    ? `\\\\.\\pipe\\companions-delegate-${id}`
    : path.join(tmp, `companions-delegate-${id}.sock`);
}

export class CompanionsHostServer {
  private server?: net.Server;
  private address?: string;
  private listening?: Promise<string | undefined>;
  /** Tokens currently valid. One per live session; revoked on restart. */
  private readonly tokens = new Set<string>();
  /** Which tool set a token's handshake advertises. Default is delegate. */
  private readonly tokenModes = new Map<string, CompanionsTokenMode>();
  /** Outstanding calls by host id. */
  private readonly open = new Map<string, Outstanding>();
  /** Sockets that completed the handshake, by token, so revoking a session
   *  tears its connection down instead of leaving an authenticated pipe open. */
  private readonly sockets = new Map<string, Set<net.Socket>>();
  private disposed = false;

  constructor(private readonly opts: CompanionsServerOptions) {}

  /**
   * Bind the pipe. Idempotent and safe to call concurrently — the promise is
   * cached, so N sessions starting at once share one listen.
   *
   * Resolves `undefined` when the pipe could not be bound. Deliberately not
   * fatal (§6.4.1): without an address `spawnSpec` returns nothing, the CLI is
   * handed no server, and the only loss is that this session cannot delegate.
   * A failed listen must never keep a session from starting.
   */
  async listen(): Promise<string | undefined> {
    if (this.disposed) return undefined;
    if (this.address) return this.address;
    if (this.listening) return this.listening;
    this.listening = new Promise<string | undefined>((resolve) => {
      const uuid = this.opts.uuid ?? randomUUID;
      const address = companionsPipeAddress(uuid());
      const server = net.createServer((socket) => this.accept(socket));
      const fail = (error: Error) => {
        this.opts.log(`[companions] could not listen on ${address}: ${error.message}`);
        try { server.close(); } catch { /* never bound */ }
        this.server = undefined;
        this.listening = undefined;
        resolve(undefined);
      };
      server.once("error", fail);
      server.listen(address, () => {
        server.removeListener("error", fail);
        // A later error on a bound server (EPIPE from a dead peer) is noise, not
        // a reason to take the channel down for every other session.
        server.on("error", (error) => this.opts.log(`[companions] server error: ${error.message}`));
        this.server = server;
        this.address = address;
        this.opts.log(`[companions] listening on ${address}`);
        resolve(address);
      });
      // Never hold the host process open on our account.
      server.unref?.();
    });
    return this.listening;
  }

  /** Mint a token for one session. The caller keeps it to revoke later. */
  register(mode: CompanionsTokenMode = "delegate"): string {
    const token = (this.opts.mintToken ?? (() => randomBytes(32).toString("hex")))();
    this.tokens.add(token);
    this.tokenModes.set(token, mode);
    return token;
  }

  /**
   * The `mcpServers` entry to hand this session, or `undefined` when the pipe
   * never came up.
   *
   * `env` carries the address and the token; `args` carries only the script
   * path. That split is the whole security model on Windows, where the pipe has
   * no ACL: argv is readable by every process on the machine, an environment
   * block is not. §12.1: a token for session A can never spawn on behalf of B.
   */
  spawnSpec(token: string): AcpMcpStdioServer | undefined {
    if (!this.address || !this.tokens.has(token)) return undefined;
    return {
      name: COMPANIONS_SERVER_NAME,
      // Same pattern as claude-backend.ts: the Electron binary re-entered as a
      // plain Node. There is no separate node to find, and no shell involved.
      command: this.opts.nodePath || process.execPath,
      args: [this.opts.scriptPath],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: COMPANIONS_ADDRESS_ENV, value: this.address },
        { name: COMPANIONS_TOKEN_ENV, value: token },
      ],
    };
  }

  /**
   * Invalidate a session's token: its calls are abandoned, its connections
   * dropped, and any later hello on that token is refused.
   */
  revoke(token: string): void {
    this.tokenModes.delete(token);
    if (!this.tokens.delete(token)) return;
    for (const [id, entry] of [...this.open]) {
      if (entry.token !== token) continue;
      entry.settled = true;
      this.open.delete(id);
      // Answer the CLI before dropping the socket: a `tools/call` left hanging
      // is a run that never continues.
      this.writeResult(entry, { error: "The session this subagent belonged to has ended." });
      this.opts.onAbandon(token, id);
    }
    for (const socket of this.sockets.get(token) ?? []) {
      try { socket.destroy(); } catch { /* already gone */ }
    }
    this.sockets.delete(token);
  }

  /**
   * Shut the channel down. Called from the sidebar's `dispose`, which VS Code
   * runs on window reload and on extension deactivation alike.
   */
  dispose(): void {
    this.disposed = true;
    for (const token of [...this.tokens]) this.revoke(token);
    // Belt and braces: a call whose token was already revoked elsewhere would
    // otherwise sit here with a live socket and no reply coming.
    for (const [id, entry] of [...this.open]) {
      entry.settled = true;
      this.open.delete(id);
      this.writeResult(entry, { error: "The editor closed while this subagent was running." });
      this.opts.onAbandon(entry.token, id);
    }
    try { this.server?.close(); } catch { /* not listening */ }
    this.server = undefined;
    this.address = undefined;
    this.listening = undefined;
  }

  /** Open call count. Tests and the reaper read it; nothing else should. */
  get openCount(): number { return this.open.size; }

  /** The primer handed to the CLI as the server's `instructions` (§6.9). */
  static get primer(): string { return COMPANIONS_PRIMER; }

  // ---------- internals ----------

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8");
    let token: string | undefined;
    let buffered = "";
    // A connection that never says hello is an unknown peer holding a handle on
    // our pipe. Give it one second, then drop it.
    const helloTimer = setTimeout(() => {
      if (!token) {
        this.opts.log("[companions] dropping a connection that never sent hello");
        try { socket.destroy(); } catch { /* already gone */ }
      }
    }, 1000);
    helloTimer.unref?.();

    socket.on("data", (chunk: string) => {
      buffered += chunk;
      let cut: number;
      while ((cut = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 1);
        if (!token) {
          const verdict = checkHello(parseClientFrame(line), (candidate) => this.tokens.has(candidate));
          if (!verdict.ok) {
            this.opts.log(`[companions] handshake refused: ${verdict.reason}`);
            try { socket.write(encodeFrame({ t: "denied", reason: verdict.reason })); } catch { /* going away */ }
            socket.end();
            return;
          }
          token = verdict.token;
          clearTimeout(helloTimer);
          let peers = this.sockets.get(token);
          if (!peers) this.sockets.set(token, (peers = new Set()));
          peers.add(socket);
          try {
            // The generated schemas and the primer travel with the handshake —
            // see CompanionsReadyFrame for why they cannot live in the script.
            const mode = this.tokenModes.get(token) ?? "delegate";
            socket.write(encodeFrame({
              t: "ready",
              v: COMPANIONS_IPC_VERSION,
              tools: (mode === "generator" ? GENERATOR_TOOLS : COMPANIONS_TOOLS) as unknown as unknown[],
              instructions: mode === "generator" ? GENERATOR_PRIMER : COMPANIONS_PRIMER,
            }));
          } catch { /* going away */ }
          continue;
        }
        this.handleFrame(token, socket, line);
      }
      // A peer that floods us without newlines would grow this string without
      // bound. A spawn's task and context are prose, so 1 MiB is far past any
      // legitimate payload.
      if (buffered.length > 1_000_000) {
        this.opts.log("[companions] dropping a connection that sent an oversized frame");
        try { socket.destroy(); } catch { /* already gone */ }
      }
    });

    const teardown = () => {
      clearTimeout(helloTimer);
      if (token) this.sockets.get(token)?.delete(socket);
      // The child died mid-call: the CLI is gone, so nothing is waiting for this
      // result any more. Tell the sidebar so the children it started are
      // cancelled rather than left running for a parent that no longer exists.
      for (const [id, entry] of [...this.open]) {
        if (entry.socket !== socket) continue;
        entry.settled = true;
        this.open.delete(id);
        this.opts.onAbandon(entry.token, id);
      }
    };
    socket.on("close", teardown);
    socket.on("error", (error) => {
      this.opts.log(`[companions] connection error: ${error.message}`);
      teardown();
      try { socket.destroy(); } catch { /* already gone */ }
    });
  }

  private handleFrame(token: string, socket: net.Socket, line: string): void {
    const frame = parseClientFrame(line);
    if (!frame || frame.t !== "call") return; // unknown or malformed: keep the connection
    // The id is namespaced by us, not by the child: two MCP servers from two
    // sessions both start counting at 1, and a host id has to be unique.
    const id = `mcp:${token.slice(0, 8)}:${frame.id}`;
    if (this.open.has(id)) return; // duplicate call for one id — first wins
    const entry: Outstanding = { token, socket, clientId: frame.id, settled: false };
    this.open.set(id, entry);
    const call: CompanionsCall = {
      id,
      tool: frame.tool,
      args: frame.args,
      resolve: (payload) => this.settle(id, { payload }),
      fail: (message) => this.settle(id, { error: message }),
      get open() { return !entry.settled; },
    };
    this.opts.onCall(token, call);
  }

  /**
   * Write the terminal frame for one call, exactly once.
   *
   * The single-settle rule matters more here than for a question card: a second
   * result would desynchronize the child's request table, and the child would
   * hand a stale payload to whatever call reused the id.
   */
  private settle(id: string, body: { payload?: unknown; error?: string }): boolean {
    const entry = this.open.get(id);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    this.open.delete(id);
    return this.writeResult(entry, body);
  }

  private writeResult(entry: Outstanding, body: { payload?: unknown; error?: string }): boolean {
    try {
      entry.socket.write(encodeFrame({ t: "result", id: entry.clientId, ...body }));
      return true;
    } catch (error) {
      this.opts.log(`[companions] could not deliver a result: ${(error as Error).message}`);
      return false;
    }
  }
}
