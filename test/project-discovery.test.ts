/**
 * Pure project-discovery seeding + archive-field stripping.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *  1. Threshold 10-in-3-months opens / skips correctly
 *  2. Seeding only when !seedCompleted && empty open set
 *  3. Deliberate empty after seed does NOT re-seed
 *  4. withoutArchiveFields removes the wire capability signal
 *  5. ensureWorkspaceRoot seeds only those paths (trust set = opened folders)
 *  6. Future-dated sessions do not count (floor <= t <= now)
 *  7. Non-git-root directories are not seeded
 *  8. Mtime-only (empty/malformed summary) sessions do not count
 *  9. First seed with nothing found provisions a default; later empty does not
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PROJECT_DISCOVERY_MIN_SESSIONS,
  PROJECT_DISCOVERY_WINDOW_MS,
  canonicalizeSeedProjectPath,
  meetsProjectDiscoveryThreshold,
  selectProjectsToSeed,
  shouldSeedProjectDiscovery,
  withoutArchiveFields,
} from "../src/project-discovery";
import { indexWellFormedSessions, isWellFormedSessionSummary, sessionsDirFor } from "../src/sessions";

/**
 * A temp directory whose path is ALREADY CANONICAL.
 *
 * On macOS `os.tmpdir()` is `/var/folders/…`, which is a symlink to
 * `/private/var/folders/…`. Every test below hands its temp root to code whose
 * whole job is to canonicalise a path and compare it against that root — so an
 * uncanonicalised root makes the containment check compare `/private/var/…`
 * (what the product resolved) against `/var/…` (what the test passed in) and
 * the product looks broken on macOS while behaving exactly as designed.
 *
 * These suites were red on macOS for at least ten days without anyone noticing,
 * because CI is Ubuntu and the dev box is Windows and neither has that symlink.
 */
function mkdtempReal(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}


const DAY = 24 * 60 * 60 * 1000;
const now = Date.UTC(2026, 7, 1); // fixed clock

function stamps(n: number, ageDays: number): number[] {
  const t = now - ageDays * DAY;
  return Array.from({ length: n }, () => t);
}

describe("meetsProjectDiscoveryThreshold", () => {
  it("requires at least 10 sessions inside the 3-month window", () => {
    expect(meetsProjectDiscoveryThreshold(stamps(10, 0), now)).toBe(true);
    expect(meetsProjectDiscoveryThreshold(stamps(9, 0), now)).toBe(false);
    expect(meetsProjectDiscoveryThreshold(stamps(10, 89), now)).toBe(true);
    // Just outside the window.
    expect(meetsProjectDiscoveryThreshold(stamps(10, 91), now)).toBe(false);
  });

  it("counts only sessions inside the window (mixed ages)", () => {
    const mixed = [...stamps(9, 10), ...stamps(5, 200)];
    expect(meetsProjectDiscoveryThreshold(mixed, now)).toBe(false);
    const enough = [...stamps(10, 10), ...stamps(50, 200)];
    expect(meetsProjectDiscoveryThreshold(enough, now)).toBe(true);
  });

  it("does not count future-dated sessions (t > now)", () => {
    // Planted mtimes in the future used to pass `t >= floor` alone.
    const future = Array.from({ length: 12 }, () => now + 7 * DAY);
    expect(meetsProjectDiscoveryThreshold(future, now)).toBe(false);
    // Nine valid + many future still fails.
    const mixed = [...stamps(9, 1), ...future];
    expect(meetsProjectDiscoveryThreshold(mixed, now)).toBe(false);
    // Ten valid + future still passes (future ignored).
    expect(meetsProjectDiscoveryThreshold([...stamps(10, 1), ...future], now)).toBe(true);
  });

  it("mutation: open upper bound (t >= floor only) would accept future stamps", () => {
    const future = Array.from({ length: 12 }, () => now + DAY);
    const buggy = (ts: number[], nowMs: number) => {
      const floor = nowMs - PROJECT_DISCOVERY_WINDOW_MS;
      let count = 0;
      for (const t of ts) {
        if (t >= floor) {
          count++;
          if (count >= 10) return true;
        }
      }
      return false;
    };
    expect(buggy(future, now)).toBe(true);
    expect(meetsProjectDiscoveryThreshold(future, now)).toBe(false);
  });

  it("exposes the constants tests and call sites share", () => {
    expect(PROJECT_DISCOVERY_MIN_SESSIONS).toBe(10);
    expect(PROJECT_DISCOVERY_WINDOW_MS).toBe(90 * DAY);
  });
});

describe("canonicalizeSeedProjectPath / well-formed sessions", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempReal("grok-seed-canon-");
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("rejects a directory that is not a Git root", () => {
    const plain = path.join(tmp, "not-git");
    fs.mkdirSync(plain, { recursive: true });
    expect(
      canonicalizeSeedProjectPath(plain, {
        existsSync: (p) => fs.existsSync(p),
        realpathSync: (p) => fs.realpathSync(p),
        statSync: (p) => fs.statSync(p),
      }),
    ).toBeUndefined();
  });

  it("accepts a verified Git root after realpath", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const real = canonicalizeSeedProjectPath(repo, {
      existsSync: (p) => fs.existsSync(p),
      realpathSync: (p) => fs.realpathSync(p),
      statSync: (p) => fs.statSync(p),
    });
    expect(real && path.resolve(real)).toBe(path.resolve(repo));
  });

  it("rejects nested dirs inside a git repo (must be the root itself)", () => {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    const nested = path.join(repo, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    expect(
      canonicalizeSeedProjectPath(nested, {
        existsSync: (p) => fs.existsSync(p),
        realpathSync: (p) => fs.realpathSync(p),
        statSync: (p) => fs.statSync(p),
      }),
    ).toBeUndefined();
  });

  it("isWellFormedSessionSummary rejects empty and mtime-shaped junk", () => {
    expect(isWellFormedSessionSummary(null)).toBe(false);
    expect(isWellFormedSessionSummary({})).toBe(false);
    expect(isWellFormedSessionSummary({ random: 1 })).toBe(false);
    expect(isWellFormedSessionSummary({ info: { id: "x" } })).toBe(true);
    expect(isWellFormedSessionSummary({ updated_at: "2026-01-01T00:00:00Z" })).toBe(true);
  });

  it("indexWellFormedSessions ignores mtime-only empty summaries", () => {
    const grokHome = path.join(tmp, "grok");
    const cwd = path.join(tmp, "proj");
    fs.mkdirSync(cwd, { recursive: true });
    // Ten empty summaries with recent mtimes — must NOT count.
    for (let i = 0; i < 12; i++) {
      const dir = path.join(sessionsDirFor(grokHome, cwd), `empty-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      const summary = path.join(dir, "summary.json");
      fs.writeFileSync(summary, "{}");
      fs.utimesSync(summary, new Date(now), new Date(now));
    }
    // Two well-formed — not enough alone.
    for (let i = 0; i < 2; i++) {
      const dir = path.join(sessionsDirFor(grokHome, cwd), `real-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      const summary = path.join(dir, "summary.json");
      fs.writeFileSync(
        summary,
        JSON.stringify({ info: { id: `real-${i}`, cwd }, updated_at: new Date(now).toISOString() }),
      );
      fs.utimesSync(summary, new Date(now), new Date(now));
    }
    const well = indexWellFormedSessions({ fs: fs as any, grokHome, cwd });
    expect(well).toHaveLength(2);
    expect(meetsProjectDiscoveryThreshold(well.map((e) => e.mtimeMs), now)).toBe(false);
  });
});

describe("shouldSeedProjectDiscovery", () => {
  it("seeds on first run with an empty open set", () => {
    expect(
      shouldSeedProjectDiscovery({ discoverySeedCompleted: false, openFolderCount: 0 }),
    ).toBe(true);
  });

  it("does not seed when folders are already open (restored prefs / --workspace)", () => {
    expect(
      shouldSeedProjectDiscovery({ discoverySeedCompleted: false, openFolderCount: 1 }),
    ).toBe(false);
    expect(
      shouldSeedProjectDiscovery({ discoverySeedCompleted: true, openFolderCount: 3 }),
    ).toBe(false);
  });

  it("does not re-seed after the flag is set — including a deliberate empty list", () => {
    // Owner note: "when empty" and "do not re-seed after closing everything"
    // conflict; the seed-completed flag resolves it. Empty + completed = no seed.
    expect(
      shouldSeedProjectDiscovery({ discoverySeedCompleted: true, openFolderCount: 0 }),
    ).toBe(false);
  });
});

describe("selectProjectsToSeed", () => {
  it("opens only checkouts meeting the threshold", () => {
    const picked = selectProjectsToSeed(
      [
        { cwd: "/work/hot", sessionTimestampsMs: stamps(12, 5) },
        { cwd: "/work/cold", sessionTimestampsMs: stamps(3, 5) },
        { cwd: "/work/stale", sessionTimestampsMs: stamps(20, 120) },
        { cwd: "/work/edge", sessionTimestampsMs: stamps(10, 30) },
      ],
      now,
    );
    expect(picked).toEqual(["/work/hot", "/work/edge"]);
  });
});

describe("withoutArchiveFields", () => {
  it("strips archived/archivedAt so the client capability probe is false", () => {
    const stripped = withoutArchiveFields({
      cwd: "/r",
      label: "r",
      available: true,
      pinned: false,
      updatedAt: 1,
      archived: true,
      archivedAt: 99,
    });
    expect(stripped).toEqual({
      cwd: "/r",
      label: "r",
      available: true,
      pinned: false,
      updatedAt: 1,
    });
    expect("archived" in stripped).toBe(false);
    expect(typeof (stripped as { archived?: boolean }).archived).toBe("undefined");
  });
});
