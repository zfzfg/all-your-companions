/**
 * I/O half of AP-13a against an injected GitRunner — never a real `git`.
 *
 * Create / apply / remove in the normal case; git exit ≠ 0; destination already
 * exists; source file changed since the branch point → conflict, no write.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  LocalGitWorktrees,
  nodeGitRunner,
  type GitRunner,
  type WorktreeLocalFs,
} from "../src/worktree-local";

const root = dirname(fileURLToPath(import.meta.url));

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function dec(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

interface FakeGit {
  /** argv joined with space → result. First match wins. */
  answers: Array<{ match: (args: string[], cwd: string) => boolean; result: { code: number; stdout: string; stderr: string; bytes?: Uint8Array } }>;
  calls: Array<{ args: string[]; cwd: string }>;
}

function fakeGit(script: FakeGit["answers"]): GitRunner & { calls: FakeGit["calls"] } {
  const calls: FakeGit["calls"] = [];
  const run = async (args: string[], cwd: string) => {
    calls.push({ args: [...args], cwd });
    const hit = script.find((s) => s.match(args, cwd));
    if (!hit) return { code: 1, stdout: "", stderr: `unexpected git ${args.join(" ")}` };
    return { code: hit.result.code, stdout: hit.result.stdout, stderr: hit.result.stderr };
  };
  return {
    calls,
    run,
    runBytes: async (args, cwd) => {
      calls.push({ args: [...args], cwd });
      const hit = script.find((s) => s.match(args, cwd));
      if (!hit) return { code: 1, stdout: new Uint8Array(), stderr: `unexpected git ${args.join(" ")}` };
      return {
        code: hit.result.code,
        stdout: hit.result.bytes ?? new TextEncoder().encode(hit.result.stdout),
        stderr: hit.result.stderr,
      };
    },
  };
}

function memFs(initial: Record<string, string | null> = {}): WorktreeLocalFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  for (const [p, v] of Object.entries(initial)) {
    if (v !== null) files.set(p, enc(v));
  }
  const dirs = new Set<string>();
  return {
    files,
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      const b = files.get(p);
      if (!b) throw new Error(`ENOENT ${p}`);
      return b;
    },
    writeFileSync: (p, data) => {
      files.set(p, data instanceof Uint8Array ? data : enc(String(data)));
    },
    mkdirSync: (p) => {
      dirs.add(p);
    },
    unlinkSync: (p) => {
      files.delete(p);
    },
    rmSync: (p) => {
      files.delete(p);
      dirs.delete(p);
    },
  };
}

function posixJoin(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
}

const inspectOk: FakeGit["answers"] = [
  { match: (a) => a[0] === "rev-parse" && a[1] === "--is-inside-work-tree", result: { code: 0, stdout: "true\n", stderr: "" } },
  { match: (a) => a[0] === "config" && a.includes("core.sparseCheckout"), result: { code: 1, stdout: "", stderr: "" } },
  { match: (a) => a[0] === "config" && a.includes("filter.lfs.smudge"), result: { code: 1, stdout: "", stderr: "" } },
];

describe("LocalGitWorktrees.create", () => {
  it("runs git worktree add -b without a shell, under the host-owned root", async () => {
    const git = fakeGit([
      ...inspectOk,
      { match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel", result: { code: 0, stdout: "/repos/app\n", stderr: "" } },
      { match: (a) => a[0] === "worktree" && a[1] === "list", result: { code: 0, stdout: "worktree /repos/app\nHEAD a\nbranch refs/heads/main\n", stderr: "" } },
      { match: (a) => a[0] === "worktree" && a[1] === "add", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    const fs = memFs();
    const ops = new LocalGitWorktrees({ git, fs, join: posixJoin, now: () => 0 });
    const created = await ops.create({ sourcePath: "/repos/app", label: "feat auth", root: "/home/u/.grok/worktrees" });
    expect(created).toEqual({
      status: "created",
      worktreePath: "/home/u/.grok/worktrees/app/feat-auth",
      sourceGitRoot: "/repos/app",
    });
    const add = git.calls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
    expect(add?.args).toEqual(["worktree", "add", "-b", "companions/feat-auth", "--", "/home/u/.grok/worktrees/app/feat-auth"]);
    expect(add?.cwd).toBe("/repos/app");
  });

  it("refuses when git exits non-zero", async () => {
    const git = fakeGit([
      ...inspectOk,
      { match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel", result: { code: 0, stdout: "/repos/app\n", stderr: "" } },
      { match: (a) => a[0] === "worktree" && a[1] === "list", result: { code: 0, stdout: "worktree /repos/app\nHEAD a\nbranch refs/heads/main\n", stderr: "" } },
      { match: (a) => a[0] === "worktree" && a[1] === "add", result: { code: 128, stdout: "", stderr: "fatal: already exists\n" } },
    ]);
    const ops = new LocalGitWorktrees({ git, fs: memFs(), join: posixJoin, now: () => 0 });
    const r = await ops.create({ sourcePath: "/repos/app", label: "feat", root: "/wt" });
    expect(r).toEqual({ error: "fatal: already exists" });
  });

  it("suffixes the label when the destination already exists rather than clobbering it", async () => {
    const dest = "/wt/app/feat";
    const git = fakeGit([
      ...inspectOk,
      { match: (a) => a[0] === "rev-parse" && a[1] === "--show-toplevel", result: { code: 0, stdout: "/repos/app\n", stderr: "" } },
      { match: (a) => a[0] === "worktree" && a[1] === "list", result: { code: 0, stdout: "worktree /repos/app\nHEAD a\nbranch refs/heads/main\n", stderr: "" } },
      { match: (a) => a[0] === "worktree" && a[1] === "add", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    const fs = memFs({ [dest]: "occupied" });
    const ops = new LocalGitWorktrees({ git, fs, join: posixJoin, now: () => 0 });
    const r = await ops.create({ sourcePath: "/repos/app", label: "feat", root: "/wt" });
    expect(r).toEqual({
      status: "created",
      worktreePath: "/wt/app/feat-2",
      sourceGitRoot: "/repos/app",
    });
    const add = git.calls.find((c) => c.args[1] === "add");
    expect(add?.args).toEqual(["worktree", "add", "-b", "companions/feat-2", "--", "/wt/app/feat-2"]);
  });

  it("refuses submodules, sparse-checkout and LFS rather than half-doing them", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--is-inside-work-tree", result: { code: 0, stdout: "true\n", stderr: "" } },
      { match: (a) => a[0] === "config" && a.includes("core.sparseCheckout"), result: { code: 0, stdout: "true\n", stderr: "" } },
    ]);
    const ops = new LocalGitWorktrees({ git, fs: memFs(), join: posixJoin });
    const r = await ops.create({ sourcePath: "/repos/app", label: "x", root: "/wt" });
    expect(r).toMatchObject({ error: expect.stringContaining("sparse-checkout") });
  });
});

describe("LocalGitWorktrees.apply", () => {
  const baseScripts: FakeGit["answers"] = [
    ...inspectOk,
    { match: (a) => a[0] === "rev-parse" && a[1] === "HEAD", result: { code: 0, stdout: "wt-head\n", stderr: "" } },
    { match: (a) => a[0] === "merge-base", result: { code: 0, stdout: "base-sha\n", stderr: "" } },
    { match: (a) => a[0] === "diff" && a.includes("--name-status"), result: { code: 0, stdout: "M\tsrc/a.ts\n", stderr: "" } },
    { match: (a) => a[0] === "show" && a[1] === "base-sha:src/a.ts", result: { code: 0, stdout: "old\n", stderr: "", bytes: enc("old\n") } },
  ];

  it("copies a file whose source is still at the merge-base", async () => {
    const git = fakeGit(baseScripts);
    const fs = memFs({
      "/wt/feat/src/a.ts": "new\n",
      "/repos/app/src/a.ts": "old\n",
    });
    const ops = new LocalGitWorktrees({ git, fs, join: posixJoin });
    const r = await ops.apply({ worktreePath: "/wt/feat", sourceGitRoot: "/repos/app" });
    expect(r).toMatchObject({ status: "success", gitRoot: "/repos/app" });
    expect("files" in r && r.files).toEqual([
      { path: "src/a.ts", type: "modified", additions: 0, deletions: 0 },
    ]);
    expect(dec(fs.files.get("/repos/app/src/a.ts")!)).toBe("new\n");
  });

  it("does not write when the source file changed since the branch point", async () => {
    const git = fakeGit(baseScripts);
    const fs = memFs({
      "/wt/feat/src/a.ts": "new\n",
      "/repos/app/src/a.ts": "foreign\n",
    });
    const ops = new LocalGitWorktrees({ git, fs, join: posixJoin });
    const r = await ops.apply({ worktreePath: "/wt/feat", sourceGitRoot: "/repos/app" });
    expect(r).toEqual({
      error: "source files changed since the worktree branched",
      conflicts: ["src/a.ts"],
    });
    expect(dec(fs.files.get("/repos/app/src/a.ts")!)).toBe("foreign\n");
  });

  it("overwrite: true writes the conflicting file after an explicit confirm", async () => {
    const git = fakeGit(baseScripts);
    const fs = memFs({
      "/wt/feat/src/a.ts": "new\n",
      "/repos/app/src/a.ts": "foreign\n",
    });
    const ops = new LocalGitWorktrees({ git, fs, join: posixJoin });
    const r = await ops.apply({ worktreePath: "/wt/feat", sourceGitRoot: "/repos/app", overwrite: true });
    expect(r).toMatchObject({ status: "success" });
    expect(dec(fs.files.get("/repos/app/src/a.ts")!)).toBe("new\n");
  });

  it("surfaces a non-zero git diff as an error and writes nothing", async () => {
    const git = fakeGit([
      ...inspectOk,
      { match: (a) => a[0] === "rev-parse" && a[1] === "HEAD", result: { code: 0, stdout: "h\n", stderr: "" } },
      { match: (a) => a[0] === "merge-base", result: { code: 0, stdout: "b\n", stderr: "" } },
      { match: (a) => a[0] === "diff", result: { code: 128, stdout: "", stderr: "fatal: bad revision\n" } },
    ]);
    const fs = memFs({ "/repos/app/src/a.ts": "keep\n" });
    const ops = new LocalGitWorktrees({ git, fs, join: posixJoin });
    const r = await ops.apply({ worktreePath: "/wt/feat", sourceGitRoot: "/repos/app" });
    expect(r).toEqual({ error: "fatal: bad revision" });
    expect(dec(fs.files.get("/repos/app/src/a.ts")!)).toBe("keep\n");
  });
});

describe("LocalGitWorktrees.remove", () => {
  it("passes --force only when asked, and never via a shell string", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-common-dir", result: { code: 0, stdout: "/repos/app/.git\n", stderr: "" } },
      { match: (a) => a[0] === "worktree" && a[1] === "remove", result: { code: 0, stdout: "", stderr: "" } },
    ]);
    const ops = new LocalGitWorktrees({ git, fs: memFs(), join: posixJoin, dirname: posixDirname, basename: posixBasename });
    const r = await ops.remove({ worktreePath: "/wt/feat", force: true });
    expect(r).toEqual({ removed: true, resolvedPath: "/wt/feat" });
    const rm = git.calls.find((c) => c.args[1] === "remove");
    expect(rm?.args).toEqual(["worktree", "remove", "--force", "--", "/wt/feat"]);
    expect(rm?.cwd).toBe("/repos/app");
  });

  it("without force, omits --force so a dirty worktree stays", async () => {
    const git = fakeGit([
      { match: (a) => a[0] === "rev-parse" && a[1] === "--git-common-dir", result: { code: 0, stdout: "/repos/app/.git\n", stderr: "" } },
      { match: (a) => a[0] === "worktree" && a[1] === "remove", result: { code: 128, stdout: "", stderr: "fatal: '/wt/feat' contains modified or untracked files, use --force to delete it\n" } },
    ]);
    const ops = new LocalGitWorktrees({ git, fs: memFs(), join: posixJoin, dirname: posixDirname, basename: posixBasename });
    const r = await ops.remove({ worktreePath: "/wt/feat", force: false });
    expect(r).toEqual({ error: "fatal: '/wt/feat' contains modified or untracked files, use --force to delete it" });
    expect(git.calls.find((c) => c.args[1] === "remove")?.args).toEqual(["worktree", "remove", "--", "/wt/feat"]);
  });
});

describe("nodeGitRunner spawn flags", () => {
  it("calls execFile with an argv array and without shell: true (DEP0190)", async () => {
    const calls: any[] = [];
    const execFile = ((file: string, args: string[], opts: object, cb: Function) => {
      calls.push({ file, args, opts });
      cb(null, Buffer.from("ok"), Buffer.from(""));
    }) as any;
    const git = nodeGitRunner({ execFile, timeoutMs: 1000 });
    await git.run(["status", "--porcelain"], "/repos/app");
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe("git");
    expect(calls[0].args).toEqual(["status", "--porcelain"]);
    expect(calls[0].opts.cwd).toBe("/repos/app");
    expect(calls[0].opts.windowsHide).toBe(true);
    expect(calls[0].opts.shell).toBeUndefined();
    expect(calls[0].opts.env.GIT_TERMINAL_PROMPT).toBe("0");
  });
});

describe("sidebar provider choice (source pin)", () => {
  it("uses the local git path when no live Grok session exists, and never starts Grok just to create", () => {
    const src = readFileSync(join(root, "..", "src", "sidebar.ts"), "utf8");
    expect(src).toContain("using local git (linked worktree; clone mode is Grok-only)");
    expect(src).toContain("using Grok RPC (clone mode available)");
    expect(src).toContain("liveGrokWorktreeClient");
    expect(src).toContain("createWorktreeViaLocalGit");
    // The old "start Grok or fail" path is gone — a missing Grok is the local path.
    const createStart = src.indexOf("Creating git worktree");
    const createRegion = src.slice(createStart, src.indexOf("watchWorktreeCreate", createStart));
    expect(createRegion).not.toContain("Could not start Grok to create a worktree.");
    expect(createRegion).not.toContain("clientForWorktreeCreate");
  });
});

function posixDirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? trimmed : trimmed.slice(0, i);
}

function posixBasename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}
