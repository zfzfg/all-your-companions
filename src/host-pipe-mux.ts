/**
 * One pipe, two protocols (P6, §16 "Multiplex `ask_user` and `companions` on
 * one pipe?").
 *
 * AP-05 and AP-16 each shipped with a listener of their own, and v1 said so
 * deliberately: `ask-user-server.ts` is question-shaped — one outstanding
 * request settled by a human — and the delegation channel is call-shaped, with
 * several long-running children per session. Two listeners was the honest way
 * to get both working without refactoring the first one's settle paths under
 * the second one's deadline.
 *
 * What that left behind is two named pipes per window for one extension, two
 * addresses to bind on a machine where binding can fail, and two places to get
 * the handshake right. This file removes the duplication WITHOUT touching
 * either protocol: the mux owns the socket up to and including the handshake,
 * then hands the authenticated connection to whichever server minted the token.
 *
 * **The token is the routing.** Nothing in either wire format had to change,
 * because tokens are minted per server and never collide: a 256-bit random
 * value that `AskUserServer` knows is, by construction, not one
 * `CompanionsHostServer` knows. So both shipped scripts keep speaking exactly
 * what they spoke before, both env vars keep their names, and the only thing
 * that differs is that they now point at the same address.
 *
 * Pure of the protocols it carries: this module knows about `hello`, `ready`
 * and `denied`, and nothing else. Every frame after the handshake is opaque and
 * goes straight to the owner.
 */
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

/** How long an unauthenticated peer may hold a handle on the pipe. */
const HELLO_TIMEOUT_MS = 1000;

/**
 * A protocol that can own a connection once its token has been recognised.
 *
 * Deliberately narrow: the mux asks "is this yours?" and, if so, hands over the
 * socket plus whatever bytes arrived after the hello line. Everything else —
 * the ready frame, the per-protocol frame handling, the settle rules, the
 * teardown — stays where it already works.
 */
export interface PipeProtocol {
  /** Name for the log line, so a refused handshake says which side refused. */
  readonly protocolName: string;
  ownsToken(token: string): boolean;
  /**
   * Take over an authenticated socket.
   *
   * `leftover` is any complete-or-partial data that arrived in the same chunk
   * as the hello line. It is almost always empty — but a client that writes its
   * hello and its first real frame in one `write` is legal, and dropping that
   * frame would hang the call it belongs to.
   */
  onAuthenticated(socket: net.Socket, token: string, leftover: string): void;
}

/**
 * A pipe address that is legal on this platform.
 *
 * Windows named pipes are not files: they live in a flat kernel namespace under
 * `\\.\pipe\`, have no directory and no ACL we set here. POSIX gets a real
 * socket file in the per-user temp dir, where the 0700 tmpdir is a second
 * barrier the token does not need to be.
 */
export function hostPipeAddress(
  id: string,
  platform: NodeJS.Platform = process.platform,
  tmp = os.tmpdir(),
): string {
  // `path.posix.join`, not `path.join`: this function takes the platform as an
  // argument, so it must not also read the one it happens to be running on —
  // otherwise asking for a POSIX address on Windows answers with backslashes.
  return platform === "win32"
    ? `\\\\.\\pipe\\companions-host-${id}`
    : path.posix.join(tmp, `companions-host-${id}.sock`);
}

export interface HostPipeMuxOptions {
  log(message: string): void;
  /** Injected in tests. Defaults to `crypto.randomUUID`. */
  uuid?: () => string;
}

export class HostPipeMux {
  private server?: net.Server;
  private address?: string;
  private listening?: Promise<string | undefined>;
  private readonly protocols = new Set<PipeProtocol>();
  private disposed = false;

  constructor(private readonly opts: HostPipeMuxOptions) {}

  /** Register a protocol. Idempotent; order does not matter (tokens route). */
  add(protocol: PipeProtocol): void {
    this.protocols.add(protocol);
  }

  remove(protocol: PipeProtocol): void {
    this.protocols.delete(protocol);
  }

  /**
   * Bind the pipe. Idempotent and safe to call concurrently — the promise is
   * cached, so both protocols and N sessions starting at once share one listen.
   *
   * Resolves `undefined` when the pipe could not be bound. That stays
   * deliberately non-fatal for both callers: without an address neither hands
   * the CLI a server spec, and the only loss is that this window has no
   * question cards and no delegation. A failed listen must never keep a session
   * from starting.
   */
  async listen(): Promise<string | undefined> {
    if (this.disposed) return undefined;
    if (this.address) return this.address;
    if (this.listening) return this.listening;
    this.listening = new Promise<string | undefined>((resolve) => {
      const uuid = this.opts.uuid ?? randomUUID;
      const address = hostPipeAddress(uuid());
      const server = net.createServer((socket) => this.accept(socket));
      const fail = (error: Error) => {
        this.opts.log(`[host-pipe] could not listen on ${address}: ${error.message}`);
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
        server.on("error", (error) => this.opts.log(`[host-pipe] server error: ${error.message}`));
        this.server = server;
        this.address = address;
        this.opts.log(`[host-pipe] listening on ${address}`);
        resolve(address);
      });
      // Never hold the host process open on our account.
      server.unref?.();
    });
    return this.listening;
  }

  /** The bound address, or undefined if the pipe never came up. */
  get boundAddress(): string | undefined {
    return this.address;
  }

  /**
   * Close the pipe.
   *
   * Only the listener: the protocols own their outstanding requests and their
   * authenticated sockets, and each one's own `dispose` settles them. Closing
   * those from here would settle a question card twice.
   */
  dispose(): void {
    this.disposed = true;
    try { this.server?.close(); } catch { /* not listening */ }
    this.server = undefined;
    this.address = undefined;
    this.listening = undefined;
    this.protocols.clear();
  }

  // ---------- internals ----------

  private accept(socket: net.Socket): void {
    socket.setEncoding("utf8");
    let settled = false;
    let buffered = "";
    // A connection that never says hello is an unknown peer holding a handle on
    // our pipe. Give it a second, then drop it.
    const helloTimer = setTimeout(() => {
      if (settled) return;
      this.opts.log("[host-pipe] dropping a connection that never sent hello");
      try { socket.destroy(); } catch { /* already gone */ }
    }, HELLO_TIMEOUT_MS);
    helloTimer.unref?.();

    const onData = (chunk: string) => {
      if (settled) return;
      buffered += chunk;
      const cut = buffered.indexOf("\n");
      if (cut < 0) {
        // A peer that floods us without a newline would grow this without
        // bound. A hello frame is a few hundred bytes; 64 KiB is far past it.
        if (buffered.length > 65_536) {
          this.opts.log("[host-pipe] dropping a connection whose hello never ended");
          try { socket.destroy(); } catch { /* already gone */ }
        }
        return;
      }
      const line = buffered.slice(0, cut);
      const leftover = buffered.slice(cut + 1);
      settled = true;
      clearTimeout(helloTimer);
      socket.off("data", onData);

      const token = helloToken(line);
      const owner = token
        ? [...this.protocols].find((protocol) => protocol.ownsToken(token))
        : undefined;
      if (!owner || !token) {
        const reason = token ? "unknown token" : "expected a hello frame";
        this.opts.log(`[host-pipe] handshake refused: ${reason}`);
        try { socket.write(`${JSON.stringify({ t: "denied", reason })}\n`); } catch { /* going away */ }
        socket.end();
        return;
      }
      owner.onAuthenticated(socket, token, leftover);
    };
    socket.on("data", onData);
    // Before the handshake there is nothing to settle, so a dropped connection
    // is only a timer to clear. After it, the owner's own teardown runs.
    socket.on("close", () => clearTimeout(helloTimer));
    socket.on("error", (error) => {
      clearTimeout(helloTimer);
      if (!settled) this.opts.log(`[host-pipe] connection error before hello: ${error.message}`);
      try { socket.destroy(); } catch { /* already gone */ }
    });
  }
}

/**
 * The token out of a hello line, or undefined.
 *
 * Deliberately does NOT check the protocol version: that is each protocol's own
 * constant, and the owner re-checks it the moment it takes the socket. The mux
 * only needs enough of the frame to know whose connection this is.
 */
export function helloToken(line: string): string | undefined {
  const text = (line ?? "").trim();
  if (!text) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.t !== "hello") return undefined;
  const token = typeof record.token === "string" ? record.token.trim() : "";
  return token || undefined;
}
