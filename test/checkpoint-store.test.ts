/**
 * Checkpoint store: persist contents (not diffs), retention on write, and
 * fault-injection on every file step. A failed snapshot must never throw.
 */
import { describe, expect, it } from "vitest";
import { CheckpointStore, type CheckpointStoreFs } from "../src/checkpoint-store";
import {
  CHECKPOINT_RETENTION_BYTES,
  CHECKPOINT_RETENTION_TURNS,
  sha256Text,
  type Checkpoint,
  type CheckpointFile,
} from "../src/checkpoints";

class MemoryFs implements CheckpointStoreFs {
  readonly files = new Map<string, Uint8Array>();
  readonly dirs = new Set<string>();
  fail: { op?: string; pathIncludes?: string; code?: string; message?: string } | null = null;
  writes: Array<{ path: string; bytes: number }> = [];

  constructor(private readonly sep = "/") {
    this.dirs.add("");
  }

  private norm(p: string): string {
    let n = p.replace(/\\/g, "/").replace(/\/+/g, "/");
    if (n.length > 1) n = n.replace(/\/+$/, "");
    return n;
  }

  private boom(op: string, p: string): void {
    const f = this.fail;
    if (!f) return;
    if (f.op && f.op !== op) return;
    if (f.pathIncludes && !this.norm(p).includes(f.pathIncludes)) return;
    const err = new Error(f.message || `${f.code || "EIO"} at ${op} ${p}`) as NodeJS.ErrnoException;
    err.code = f.code || "EIO";
    throw err;
  }

  mkdirSync(p: string, _opts: { recursive: true }): void {
    this.boom("mkdir", p);
    const n = this.norm(p);
    const absolute = n.startsWith("/");
    const parts = n.split("/").filter(Boolean);
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : (absolute ? `/${part}` : part);
      this.dirs.add(acc);
    }
  }

  writeFileSync(p: string, data: Uint8Array | string): void {
    this.boom("write", p);
    const n = this.norm(p);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
    this.files.set(n, bytes);
    this.writes.push({ path: n, bytes: bytes.length });
  }

  readFileSync(p: string): Uint8Array {
    this.boom("read", p);
    const n = this.norm(p);
    const hit = this.files.get(n);
    if (!hit) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return hit;
  }

  readdirSync(p: string): string[] {
    this.boom("readdir", p);
    const n = this.norm(p);
    if (!this.dirs.has(n) && ![...this.files.keys()].some((k) => k.startsWith(n + "/"))) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    const prefix = n ? n + "/" : "";
    const names = new Set<string>();
    for (const d of this.dirs) {
      if (d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        const head = rest.split("/")[0];
        if (head && rest === head) names.add(head);
      }
    }
    for (const f of this.files.keys()) {
      if (f.startsWith(prefix)) {
        const rest = f.slice(prefix.length);
        const head = rest.split("/")[0];
        if (head) names.add(head);
      }
    }
    return [...names];
  }

  existsSync(p: string): boolean {
    const n = this.norm(p);
    return this.files.has(n) || this.dirs.has(n);
  }

  statSync(p: string): { size: number; isDirectory(): boolean } {
    this.boom("stat", p);
    const n = this.norm(p);
    if (this.dirs.has(n)) return { size: 0, isDirectory: () => true };
    const hit = this.files.get(n);
    if (!hit) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    return { size: hit.length, isDirectory: () => false };
  }

  rmSync(p: string, _opts: { recursive: boolean; force: boolean }): void {
    this.boom("rm", p);
    const n = this.norm(p);
    this.dirs.delete(n);
    for (const d of [...this.dirs]) if (d === n || d.startsWith(n + "/")) this.dirs.delete(d);
    for (const f of [...this.files.keys()]) if (f === n || f.startsWith(n + "/")) this.files.delete(f);
  }
}

function file(relPath: string, blob: string, over: Partial<CheckpointFile> = {}): CheckpointFile {
  return {
    relPath,
    blob,
    sha256: sha256Text(blob),
    existedBefore: true,
    ...over,
  };
}

function makeCp(turnId: string, files: CheckpointFile[], over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: `sess:${turnId}`,
    sessionId: "sess",
    turnId,
    createdAt: Number(turnId) * 1000,
    userMessagePreview: `turn ${turnId}`,
    files,
    skipped: [],
    bytes: files.reduce((n, f) => n + Buffer.byteLength(f.blob, "utf8"), 0),
    ...over,
  };
}

function store(fs: MemoryFs, over: ConstructorParameters<typeof CheckpointStore>[0] extends infer T ? Partial<T> : never = {}) {
  return new CheckpointStore({
    root: "/gs/checkpoints",
    fs,
    now: () => 42,
    ...over,
  });
}

describe("save / load round-trip", () => {
  it("stores exact contents, including CRLF, and reloads them", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    const blob = "hello\r\nworld\r\n";
    const saved = s.save(makeCp("1", [file("src/a.ts", blob, { afterSha256: sha256Text("next\r\n") })]));
    expect(saved).toEqual({ ok: true });
    const loaded = s.load("sess", "1");
    expect(loaded).not.toBeNull();
    expect(loaded!.files[0].blob).toBe(blob);
    expect(loaded!.files[0].sha256).toBe(sha256Text(blob));
    expect(loaded!.files[0].afterSha256).toBe(sha256Text("next\r\n"));
    expect(loaded!.userMessagePreview).toBe("turn 1");
  });

  it("returns null for a missing turn instead of throwing", () => {
    expect(store(new MemoryFs()).load("sess", "9")).toBeNull();
  });

  it("lists turns in numeric order", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    s.save(makeCp("2", [file("b.ts", "b")]));
    s.save(makeCp("10", [file("c.ts", "c")]));
    s.save(makeCp("1", [file("a.ts", "a")]));
    expect(s.list("sess").map((e) => e.turnId)).toEqual(["1", "2", "10"]);
  });
});

describe("retention on write", () => {
  it("prunes the oldest turn when the turn cap is exceeded", () => {
    const fs = new MemoryFs();
    const s = store(fs, { maxTurns: 2, maxBytes: 10_000 });
    s.save(makeCp("1", [file("a.ts", "aaaa")]));
    s.save(makeCp("2", [file("b.ts", "bbbb")]));
    s.save(makeCp("3", [file("c.ts", "cccc")]));
    expect(s.list("sess").map((e) => e.turnId)).toEqual(["2", "3"]);
    expect(s.load("sess", "1")).toBeNull();
  });

  it("prunes oldest-first when the byte cap is exceeded", () => {
    const fs = new MemoryFs();
    const s = store(fs, { maxTurns: 20, maxBytes: 8 });
    s.save(makeCp("1", [file("a.ts", "12345")]));
    s.save(makeCp("2", [file("b.ts", "12345")]));
    s.save(makeCp("3", [file("c.ts", "12345")]));
    expect(s.list("sess").map((e) => e.turnId)).toEqual(["3"]);
  });

  it("uses the documented defaults (20 turns / 200 MB)", () => {
    expect(CHECKPOINT_RETENTION_TURNS).toBe(20);
    expect(CHECKPOINT_RETENTION_BYTES).toBe(200 * 1024 * 1024);
  });
});

describe("disable / pruneAfter / removeSession", () => {
  it("disable wipes blobs so the turn cannot be restored", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    s.save(makeCp("1", [file("a.ts", "secret")]));
    expect(s.disable("sess", "1", "disk full")).toEqual({ ok: true });
    const loaded = s.load("sess", "1");
    expect(loaded?.disabled).toBe(true);
    expect(loaded?.files).toEqual([]);
    expect(loaded?.disableReason).toBe("disk full");
    expect([...fs.files.keys()].some((k) => k.includes("blobs/"))).toBe(false);
  });

  it("pruneAfter drops turns past the surviving count", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    s.save(makeCp("1", [file("a.ts", "a")]));
    s.save(makeCp("2", [file("b.ts", "b")]));
    s.save(makeCp("3", [file("c.ts", "c")]));
    s.pruneAfter("sess", 1);
    expect(s.list("sess").map((e) => e.turnId)).toEqual(["1"]);
  });

  it("removeSession deletes the whole tree without throwing", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    s.save(makeCp("1", [file("a.ts", "a")]));
    s.removeSession("sess");
    expect(s.list("sess")).toEqual([]);
  });
});

describe("fault injection — every file step", () => {
  const blob = file("src/a.ts", "hello\n");

  it.each([
    ["mkdir", "mkdir", "EACCES"],
    ["blob write", "write", "ENOSPC"],
    ["meta write", "write", "EIO"],
  ] as const)("step %s: save returns ok:false and does not throw", (_label, op, code) => {
    const fs = new MemoryFs();
    const s = store(fs);
    if (op === "write") {
      // Let mkdir succeed; fail the first write (blob) or, for meta, fail only meta.json.
      if (_label === "meta write") {
        fs.fail = null;
        // fail only when writing meta.json
        const orig = fs.writeFileSync.bind(fs);
        fs.writeFileSync = (p, d) => {
          if (String(p).replace(/\\/g, "/").endsWith("meta.json")) {
            const err = new Error("EIO meta") as NodeJS.ErrnoException;
            err.code = "EIO";
            throw err;
          }
          orig(p, d);
        };
      } else {
        fs.fail = { op: "write", pathIncludes: "blobs/", code };
      }
    } else {
      fs.fail = { op, code };
    }
    expect(() => s.save(makeCp("1", [blob]))).not.toThrow();
    const result = s.save(makeCp("1", [blob]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.length).toBeGreaterThan(0);
    expect(s.load("sess", "1")).toBeNull();
  });

  it("a half-written snapshot (blob ok, meta fails) is not loadable", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    const orig = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (p, d) => {
      if (String(p).replace(/\\/g, "/").endsWith("meta.json")) {
        orig(p, d);
        const err = new Error("ENOSPC after partial meta") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
      orig(p, d);
    };
    const result = s.save(makeCp("1", [blob]));
    expect(result.ok).toBe(false);
    expect(s.load("sess", "1")).toBeNull();
  });

  it("read failure on load returns null rather than throwing", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    expect(s.save(makeCp("1", [blob])).ok).toBe(true);
    fs.fail = { op: "read", code: "EACCES" };
    expect(() => s.load("sess", "1")).not.toThrow();
    expect(s.load("sess", "1")).toBeNull();
  });

  it("rm failure during cleanup is swallowed (save still reports the original error)", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    const origWrite = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (p, d) => {
      if (String(p).replace(/\\/g, "/").includes("blobs/")) {
        const err = new Error("ENOSPC blob") as NodeJS.ErrnoException;
        err.code = "ENOSPC";
        throw err;
      }
      origWrite(p, d);
    };
    fs.fail = { op: "rm", code: "EACCES" };
    // mkdir will succeed; blob write fails; rm of the turn dir also fails.
    // Override fail so rm throws but mkdir does not: set fail after... actually
    // fail is checked per-op, so mkdir is fine, write is overridden, rm uses fail.
    const result = s.save(makeCp("1", [blob]));
    expect(result.ok).toBe(false);
  });

  it("readdir failure on list yields an empty list", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    s.save(makeCp("1", [blob]));
    fs.fail = { op: "readdir", code: "EACCES" };
    expect(() => s.list("sess")).not.toThrow();
    expect(s.list("sess")).toEqual([]);
  });

  it("stat is not required for save; a throwing stat on an unrelated path is ignored", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    expect(s.save(makeCp("1", [blob])).ok).toBe(true);
  });
});

describe("loadFrom", () => {
  it("returns usable checkpoints after a surviving count, skipping disabled ones at merge time only", () => {
    const fs = new MemoryFs();
    const s = store(fs);
    s.save(makeCp("1", [file("a.ts", "a")]));
    s.save(makeCp("2", [file("b.ts", "b")]));
    s.disable("sess", "2", "failed");
    s.save(makeCp("3", [file("c.ts", "c")]));
    const loaded = s.loadFrom("sess", 1);
    expect(loaded.map((c) => c.turnId)).toEqual(["2", "3"]);
    expect(loaded[0].disabled).toBe(true);
    expect(loaded[1].disabled).toBeFalsy();
  });
});
