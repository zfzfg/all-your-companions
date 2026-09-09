import { describe, expect, it } from "vitest";
import { FileClaimStore, claimFileName, type ClaimFs } from "../src/file-claims";

function memFs(): ClaimFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    mkdirSync: (p) => { dirs.add(p); },
    writeFileSync: (p, data, opts) => {
      if (opts?.flag === "wx" && files.has(p)) {
        const err: any = new Error("EEXIST");
        err.code = "EEXIST";
        throw err;
      }
      files.set(p, data);
    },
    readFileSync: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
    readdirSync: (p) => [...files.keys()].filter((k) => k.startsWith(p + "/")).map((k) => k.slice(p.length + 1)),
    existsSync: (p) => files.has(p) || dirs.has(p),
    unlinkSync: (p) => { files.delete(p); },
    rmSync: (p) => {
      for (const k of [...files.keys()]) if (k === p || k.startsWith(p + "/")) files.delete(k);
      dirs.delete(p);
    },
  };
}

describe("FileClaimStore", () => {
  it("the first claim wins; a second on the same path is a card, not a write", () => {
    const fs = memFs();
    const store = new FileClaimStore({ dir: "/claims", fs, now: () => 1000, join: (...p) => p.join("/") });
    const a = store.tryClaim({ path: "src/a.ts", runId: "run-1", step: 1, role: "implementer", at: 1000 });
    const b = store.tryClaim({ path: "src/a.ts", runId: "run-2", step: 1, role: "fixer", at: 1001 });
    expect(a).toEqual({ ok: true });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.heldBy.role).toBe("implementer");
  });

  it("releaseRun drops the claims so a later run can take the path", () => {
    const fs = memFs();
    const store = new FileClaimStore({ dir: "/claims", fs, now: () => 1000, join: (...p) => p.join("/") });
    store.tryClaim({ path: "src/a.ts", runId: "run-1", step: 1, role: "implementer", at: 1000 });
    store.releaseRun("run-1");
    const again = store.tryClaim({ path: "src/a.ts", runId: "run-2", step: 1, role: "fixer", at: 2000 });
    expect(again).toEqual({ ok: true });
  });

  it("a stale claim (past TTL) is taken over rather than left as a corpse", () => {
    let now = 1000;
    const fs = memFs();
    const store = new FileClaimStore({
      dir: "/claims", fs, now: () => now, join: (...p) => p.join("/"), staleMs: 50,
    });
    store.tryClaim({ path: "src/a.ts", runId: "run-1", step: 1, role: "implementer", at: 1000 });
    now = 2000;
    const again = store.tryClaim({ path: "src/a.ts", runId: "run-2", step: 1, role: "fixer", at: 2000 });
    expect(again).toEqual({ ok: true });
  });

  it("claim file names cannot escape the store", () => {
    expect(claimFileName("../etc/passwd")).not.toContain("..");
    expect(claimFileName("src/a.ts")).toMatch(/\.json$/);
  });
});
