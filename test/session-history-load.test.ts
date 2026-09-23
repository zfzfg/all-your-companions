import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Session, runExclusiveHistoryLoad } from "../src/session";
import { GrokSidebar } from "../src/sidebar";
import type { HostMsg } from "../src/protocol";

describe("runExclusiveHistoryLoad", () => {
  it("runs the first load and keeps replaying true until it finishes", async () => {
    const session = new Session();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const seen: boolean[] = [];

    const done = runExclusiveHistoryLoad(session, async () => {
      seen.push(session.replaying);
      await gate;
      seen.push(session.replaying);
    }, { onStart() {}, onFinish() {} });

    expect(session.replaying).toBe(true);
    expect(session.loadInFlight).toBeDefined();
    release();
    await expect(done).resolves.toBe("ran");
    expect(session.replaying).toBe(false);
    expect(session.loadInFlight).toBeUndefined();
    expect(seen).toEqual([true, true]);
  });

  it("joins a second overlapping load instead of interleaving", async () => {
    const session = new Session();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = runExclusiveHistoryLoad(session, async () => {
      events.push("first-start");
      await gate;
      events.push("first-end");
    }, {
      onStart: () => events.push("start"),
      onFinish: () => events.push("finish"),
    });

    const second = runExclusiveHistoryLoad(session, async () => {
      events.push("second-ran");
    }, {
      onStart: () => events.push("second-start"),
      onFinish: () => events.push("second-finish"),
    });

    expect(session.replaying).toBe(true);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe("ran");
    expect(b).toBe("joined");
    expect(events).toEqual(["start", "first-start", "first-end", "finish"]);
    expect(session.replaying).toBe(false);
    expect(session.loadInFlight).toBeUndefined();
  });

  it("does not clear replaying when the first of two overlapping loads finishes first", async () => {
    const session = new Session();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let secondStarted = false;

    const first = runExclusiveHistoryLoad(session, async () => {
      await firstGate;
    }, { onStart() {}, onFinish() {} });

    // A joiner that is still waiting must not observe a dropped flag just
    // because its own callback never ran.
    const second = (async () => {
      const result = await runExclusiveHistoryLoad(session, async () => {
        secondStarted = true;
        await secondGate;
      }, { onStart() {}, onFinish() {} });
      return { result, replaying: session.replaying };
    })();

    expect(session.replaying).toBe(true);
    releaseFirst();
    const joined = await second;
    expect(joined.result).toBe("joined");
    expect(secondStarted).toBe(false);
    expect(joined.replaying).toBe(false);
    await first;
    expect(session.replaying).toBe(false);
  });

  it("clears the flag after a failed load so a later load can run", async () => {
    const session = new Session();
    await expect(runExclusiveHistoryLoad(session, async () => {
      throw new Error("synthetic session/load failure");
    }, { onStart() {}, onFinish() {} })).rejects.toThrow("synthetic session/load failure");
    expect(session.replaying).toBe(false);
    expect(session.loadInFlight).toBeUndefined();

    await expect(runExclusiveHistoryLoad(session, async () => {}, {
      onStart() {},
      onFinish() {},
    })).resolves.toBe("ran");
  });

  it("finishes hooks and clears the flag even when onFinish throws", async () => {
    const session = new Session();
    await expect(runExclusiveHistoryLoad(session, async () => {}, {
      onStart() {},
      onFinish() { throw new Error("snapshot failed"); },
    })).rejects.toThrow("snapshot failed");
    expect(session.replaying).toBe(false);
    expect(session.loadInFlight).toBeUndefined();
  });

  it("propagates the owner's failure to a joiner and clears the exclusive flags", async () => {
    const session = new Session();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const boom = new Error("synthetic session/load failure");

    const owner = runExclusiveHistoryLoad(session, async () => {
      await gate;
      throw boom;
    }, { onStart() {}, onFinish() {} });

    const joiner = runExclusiveHistoryLoad(session, async () => {
      throw new Error("joiner load must not run");
    }, {
      onStart() { throw new Error("joiner onStart must not run"); },
      onFinish() { throw new Error("joiner onFinish must not run"); },
    });

    expect(session.replaying).toBe(true);
    expect(session.loadInFlight).toBeDefined();
    release();

    await expect(owner).rejects.toBe(boom);
    await expect(joiner).rejects.toBe(boom);
    expect(session.replaying).toBe(false);
    expect(session.loadInFlight).toBeUndefined();
  });

  it("propagates an onFinish failure to a joiner", async () => {
    const session = new Session();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const boom = new Error("snapshot failed");

    const owner = runExclusiveHistoryLoad(session, async () => {
      await gate;
    }, {
      onStart() {},
      onFinish() { throw boom; },
    });
    const joiner = runExclusiveHistoryLoad(session, async () => {}, {
      onStart() {},
      onFinish() {},
    });

    release();
    await expect(owner).rejects.toBe(boom);
    await expect(joiner).rejects.toBe(boom);
    expect(session.replaying).toBe(false);
    expect(session.loadInFlight).toBeUndefined();
  });

  it("does not emit an unhandled rejection when a failed load has no joiner", async () => {
    const session = new Session();
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => { seen.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const owner = runExclusiveHistoryLoad(session, async () => {
        throw new Error("synthetic session/load failure");
      }, { onStart() {}, onFinish() {} });
      await Promise.resolve();
      await expect(owner).rejects.toThrow("synthetic session/load failure");
      await Promise.resolve();
      expect(seen).toEqual([]);
      expect(session.replaying).toBe(false);
      expect(session.loadInFlight).toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("replayLoadedHistory exclusive join", () => {
  function makeSidebar() {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    const emitted: HostMsg[] = [];
    let snapshots = 0;
    sidebar.emit = (_session: Session, message: HostMsg) => { emitted.push(message); };
    sidebar.sendRemoteHistorySnapshot = () => { snapshots += 1; };
    return {
      sidebar,
      emitted,
      snapshotCount: () => snapshots,
    };
  }

  // upstream ce12449: an old but EMPTY conversation must be able to switch
  // provider; only a successful replay may lift the history lock.
  it.each(["grok", "codex", "claude", "gemini"])("unlocks a successfully restored empty %s session", async (provider) => {
    const { sidebar } = makeSidebar();
    const session = new Session();
    session.provider = provider as Session["provider"];
    session.hasHistory = true;
    await sidebar.replayLoadedHistory(session, async () => {});
    expect(session.hasHistory).toBe(false);
    await sidebar.replayLoadedHistory(session, async () => { session.historyEventCount = 1; });
    expect(session.hasHistory).toBe(true);
    await expect(sidebar.replayLoadedHistory(session, async () => { throw new Error("load failed"); })).rejects.toThrow();
    expect(session.hasHistory).toBe(true);
  });

  it("does not run a second load or emit a second replay pair", async () => {
    const { sidebar, emitted, snapshotCount } = makeSidebar();
    const session = new Session();
    const events: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const first = sidebar.replayLoadedHistory(session, async () => {
      events.push("first");
      expect(session.replaying).toBe(true);
      await gate;
    });
    const second = sidebar.replayLoadedHistory(session, async () => {
      events.push("second");
    });

    expect(session.replaying).toBe(true);
    release();
    await Promise.all([first, second]);

    expect(events).toEqual(["first"]);
    expect(session.replaying).toBe(false);
    expect(session.loadInFlight).toBeUndefined();
    expect(emitted).toEqual([
      { type: "historyReplay", active: true },
      { type: "historyReplay", active: false },
    ]);
    expect(snapshotCount()).toBe(1);
  });
});

describe("history-load exclusivity wiring", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const sidebarSrc = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

  it("keeps the remote-forwarding gate as a boolean any-replay check", () => {
    expect(sidebarSrc).toMatch(/if \(!session\.replaying\) this\.sendRemoteSession/);
    expect(sidebarSrc).toMatch(/if \(session && sessionCwdOk && !session\.replaying\)/);
  });

  it("routes session/load through the exclusive join helper", () => {
    expect(sidebarSrc).toContain("runExclusiveHistoryLoad");
    expect(sidebarSrc).toMatch(/private async replayLoadedHistory[\s\S]*await runExclusiveHistoryLoad/);
  });

  it("does not invent a replay counter in the host", () => {
    expect(sidebarSrc).not.toMatch(/session\.replaying\s*\+=/);
    expect(sidebarSrc).not.toMatch(/session\.replayDepth/);
  });

  it("exports the helper from the session module used by the map", () => {
    expect(readFileSync(`${root}/src/session.ts`, "utf8")).toContain("export async function runExclusiveHistoryLoad");
  });
});
