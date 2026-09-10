/**
 * AP-05 — the host half of the `ask_user` MCP channel.
 *
 * ACP hands MCP servers to the CLI as a **stdio spec** only
 * (`AcpMcpStdioServer { name, command, args, env }`), and the CLI — not this
 * process — spawns and owns that child's stdin/stdout. So the extension host
 * cannot register itself as an MCP server. What it can do is ship a small
 * script, let the CLI start it, and keep a second channel open for the script
 * to talk back on:
 *
 * ```
 * CLI ──spawn──► ask-user-server.cjs ──pipe / unix socket──► this file ──► card
 *       stdio          (MCP JSON-RPC)      (NDJSON + token)     (webview)
 * ```
 *
 * This class owns that second channel: one listening pipe per window, one token
 * per live session, and the set of questions currently outstanding on it.
 *
 * **Every exit path cancels.** A question that is dropped without a reply
 * leaves the CLI blocked inside `tools/call` for ever — no timeout, no error,
 * just a run that never continues. Session restart, socket death, window
 * reload and extension deactivation therefore all funnel into `settle()`, and
 * the tests in `test/ask-user-ipc.test.ts` cover each of them.
 */
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import type { AcpMcpStdioServer } from "./mcp-connectors";
import { HostPipeMux, type PipeProtocol } from "./host-pipe-mux";
import {
  ASK_USER_ADDRESS_ENV,
  ASK_USER_IPC_VERSION,
  ASK_USER_SERVER_NAME,
  ASK_USER_TOKEN_ENV,
  type AskUserAnswerFrame,
  type AskUserQuestion,
  checkHello,
  encodeFrame,
  parseClientFrame,
} from "./ask-user-protocol";

/** One live question, as the sidebar sees it. */
export interface AskUserRequest {
  /** Host-unique id. Used verbatim as the question card's `requestId`. */
  id: string;
  questions: AskUserQuestion[];
  /** Deliver the user's selections. Returns false if already settled. */
  answer(
    answers: Record<string, string>,
    annotations?: Record<string, { notes?: string; preview?: string }>,
    auto?: boolean,
  ): boolean;
  /** Deliver a dismissal. Returns false if already settled. */
  cancel(auto?: boolean): boolean;
}

export interface AskUserServerOptions {
  /** Absolute path to the shipped `resources/mcp/ask-user-server.cjs`. */
  scriptPath: string;
  /** A question arrived on a registered token. Raise the card. */
  onRequest(token: string, request: AskUserRequest): void;
  /** The question with this id went away without the user acting (the CLI
   *  cancelled, or its socket died). Take the card down. */
  onWithdraw(token: string, id: string): void;
  log(message: string): void;
  /** Node to run the script with. Defaults to this process — see `spawnSpec`. */
  nodePath?: string;
  /** Injected in tests. Defaults to `crypto.randomUUID`. */
  uuid?: () => string;
  /** Injected in tests. Defaults to a 256-bit `randomBytes` hex string. */
  mintToken?: () => string;
  /** The window's shared pipe (P6). Omitted, this server binds one of its own. */
  mux?: HostPipeMux;
}

interface Outstanding {
  token: string;
  socket: net.Socket;
  /** Settle exactly once; the second call is a no-op by construction. */
  settled: boolean;
}

/**
 * A pipe address that is legal on this platform.
 *
 * Windows named pipes are not files: they live in a flat kernel namespace under
 * `\\.\pipe\`, have no directory and no ACL we set here, and a name that
 * collides is simply refused. POSIX gets a real socket file in the per-user
 * temp dir, where the 0700 tmpdir is a second barrier the token does not need
 * to be. Exported for the test that asserts both shapes without a second
 * platform.
 */
export function askUserPipeAddress(id: string, platform: NodeJS.Platform = process.platform, tmp = os.tmpdir()): string {
  return platform === "win32"
    ? `\\\\.\\pipe\\companions-ask-${id}`
    : path.join(tmp, `companions-ask-${id}.sock`);
}

export class AskUserServer implements PipeProtocol {
  /**
   * The shared window pipe (P6).
   *
   * Created here when the caller supplies none, so a standalone
   * `new AskUserServer(...)` — every existing test does exactly that — still
   * binds a pipe of its own and behaves as it always has. When the sidebar
   * passes the window's mux, this protocol shares it with the delegation
   * channel and the token is what routes a connection to the right one.
   */
  private readonly mux: HostPipeMux;
  private readonly ownsMux: boolean;
  /** Tokens currently valid. One per live session; revoked on restart. */
  private readonly tokens = new Set<string>();
  /** Outstanding questions by host id. */
  private readonly open = new Map<string, Outstanding>();
  /** Sockets that completed the handshake, by token, so revoking a session
   *  tears its connection down instead of leaving an authenticated pipe open. */
  private readonly sockets = new Map<string, Set<net.Socket>>();
  private disposed = false;

  constructor(private readonly opts: AskUserServerOptions) {
    this.mux = opts.mux ?? new HostPipeMux({ log: opts.log, ...(opts.uuid ? { uuid: opts.uuid } : {}) });
    this.ownsMux = !opts.mux;
    this.mux.add(this);
  }

  readonly protocolName = "ask_user";

  ownsToken(token: string): boolean {
    return this.tokens.has(token);
  }

  /**
   * Bind the pipe. Idempotent and safe to call concurrently — the promise is
   * cached, so N sessions starting at once share one listen.
   *
   * Resolves `undefined` when the pipe could not be bound. That is deliberately
   * not fatal: without an address `spawnSpec` returns nothing, the CLI is
   * handed no server, and the only loss is that this provider cannot raise a
   * question card. A failed listen must never keep a session from starting.
   */
  async listen(): Promise<string | undefined> {
    if (this.disposed) return undefined;
    return this.mux.listen();
  }

  /** Mint a token for one session. The caller keeps it to revoke later. */
  register(): string {
    const token = (this.opts.mintToken ?? (() => randomBytes(32).toString("hex")))();
    this.tokens.add(token);
    return token;
  }

  /**
   * The `mcpServers` entry to hand this session, or `undefined` when the pipe
   * never came up.
   *
   * `env` carries the address and the token; `args` carries only the script
   * path. That split is the whole security model on Windows, where the pipe has
   * no ACL: argv is readable by every process on the machine, an environment
   * block is not.
   */
  spawnSpec(token: string): AcpMcpStdioServer | undefined {
    const address = this.mux.boundAddress;
    if (!address || !this.tokens.has(token)) return undefined;
    return {
      name: ASK_USER_SERVER_NAME,
      // Same pattern as claude-backend.ts: the Electron binary re-entered as a
      // plain Node. There is no separate node to find, and no shell involved.
      command: this.opts.nodePath || process.execPath,
      args: [this.opts.scriptPath],
      env: [
        { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        { name: ASK_USER_ADDRESS_ENV, value: address },
        { name: ASK_USER_TOKEN_ENV, value: token },
      ],
    };
  }

  /**
   * Invalidate a session's token: its questions are cancelled, its connections
   * dropped, and any later hello on that token is refused.
   */
  revoke(token: string): void {
    if (!this.tokens.delete(token)) return;
    for (const [id, entry] of [...this.open]) {
      if (entry.token === token) this.settle(id, { t: "answer", id, outcome: "cancelled" });
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
    // Belt and braces: a question whose token was already revoked elsewhere
    // would otherwise sit here with a live socket and no reply coming.
    for (const id of [...this.open.keys()]) {
      this.settle(id, { t: "answer", id, outcome: "cancelled" });
    }
    this.mux.remove(this);
    // Only when this instance made the pipe. A mux the sidebar owns is shared
    // with the delegation channel, and closing it here would take that down
    // with a session teardown that has nothing to do with it.
    if (this.ownsMux) this.mux.dispose();
  }

  /** Open question count. Tests and the reaper read it; nothing else should. */
  get openCount(): number { return this.open.size; }

  // ---------- internals ----------

  /**
   * Take over a socket the mux has already authenticated (P6).
   *
   * Everything from here down is unchanged from when this class owned its own
   * listener: the handshake moved, the settle rules did not.
   */
  onAuthenticated(socket: net.Socket, token: string, leftover: string): void {
    let peers = this.sockets.get(token);
    if (!peers) this.sockets.set(token, (peers = new Set()));
    peers.add(socket);
    try { socket.write(encodeFrame({ t: "ready", v: ASK_USER_IPC_VERSION })); } catch { /* going away */ }

    let buffered = leftover;
    const drain = () => {
      let cut: number;
      while ((cut = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, cut);
        buffered = buffered.slice(cut + 1);
        this.handleFrame(token, socket, line);
      }
      // A peer that floods us without newlines would grow this string without
      // bound. 1 MiB is far past any legitimate four-question payload.
      if (buffered.length > 1_000_000) {
        this.opts.log("[ask_user] dropping a connection that sent an oversized frame");
        try { socket.destroy(); } catch { /* already gone */ }
      }
    };
    // A client may write its hello and its first ask in one chunk, so whatever
    // arrived with the handshake is drained before the next read.
    drain();
    socket.on("data", (chunk: string) => { buffered += chunk; drain(); });

    const teardown = () => {
      this.sockets.get(token)?.delete(socket);
      // The child died mid-question: the CLI is gone, so nothing is waiting for
      // this answer any more. Take the card down rather than leave a control
      // the user can press to no effect.
      for (const [id, entry] of [...this.open]) {
        if (entry.socket !== socket) continue;
        entry.settled = true;
        this.open.delete(id);
        this.opts.onWithdraw(entry.token, id);
      }
    };
    socket.on("close", teardown);
    socket.on("error", (error) => {
      this.opts.log(`[ask_user] connection error: ${error.message}`);
      teardown();
      try { socket.destroy(); } catch { /* already gone */ }
    });
  }

  private handleFrame(token: string, socket: net.Socket, line: string): void {
    const frame = parseClientFrame(line);
    if (!frame) return; // unknown or malformed: ignore, keep the connection
    if (frame.t === "cancel") {
      const entry = this.open.get(frame.id);
      if (!entry || entry.token !== token) return;
      entry.settled = true;
      this.open.delete(frame.id);
      this.opts.onWithdraw(token, frame.id);
      return;
    }
    if (frame.t !== "ask") return;
    // The id is namespaced by us, not by the child: two MCP servers from two
    // sessions both start counting at 1, and the card's requestId has to be
    // unique across the window.
    const id = `mcp:${token.slice(0, 8)}:${frame.id}`;
    if (this.open.has(id)) return; // duplicate ask for one call — first wins
    this.open.set(id, { token, socket, settled: false });
    const request: AskUserRequest = {
      id,
      questions: frame.questions,
      answer: (answers, annotations, auto) => this.settle(id, {
        t: "answer",
        id: frame.id,
        outcome: "accepted",
        answers,
        ...(annotations && Object.keys(annotations).length ? { annotations } : {}),
        ...(auto ? { auto: true } : {}),
      }),
      cancel: (auto) => this.settle(id, {
        t: "answer",
        id: frame.id,
        outcome: "cancelled",
        ...(auto ? { auto: true } : {}),
      }),
    };
    this.opts.onRequest(token, request);
  }

  /**
   * Write the terminal frame for one question, exactly once.
   *
   * The single-settle rule is the same stale-card invariant the RPC path
   * already keeps: a second tab, or a card replayed out of the session buffer,
   * must not be able to answer a question twice. Here a double answer would
   * also desynchronize the child's request table.
   */
  private settle(id: string, frame: AskUserAnswerFrame): boolean {
    const entry = this.open.get(id);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    this.open.delete(id);
    try {
      entry.socket.write(encodeFrame(frame));
      return true;
    } catch (error) {
      this.opts.log(`[ask_user] could not deliver an answer: ${(error as Error).message}`);
      return false;
    }
  }
}
