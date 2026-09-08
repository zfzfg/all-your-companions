// Pure tests for the rule/instruction-file panel (AP-04).
//
// `ruleFileCandidates` never touches disk, so both Windows- and POSIX-style
// paths are asserted deterministically regardless of which OS actually runs
// this suite (CI is ubuntu-latest / macos-latest only — see CLAUDE.md).
import { describe, expect, it, vi } from "vitest";
import {
  appendRuleEntry,
  buildRuleAppend,
  ensureRuleFile,
  resolveRuleFileStates,
  ruleFileCandidates,
  type RuleFile,
  type RuleFileFs,
} from "../src/rules-files";

describe("ruleFileCandidates", () => {
  it("builds all twelve project + global candidates for a POSIX cwd/home", () => {
    const files = ruleFileCandidates("/home/collin/project", "/home/collin");
    expect(files).toHaveLength(12);
    expect(files.map((f) => f.path)).toEqual([
      "/home/collin/project/AGENTS.md",
      "/home/collin/project/CLAUDE.md",
      "/home/collin/project/GEMINI.md",
      "/home/collin/project/.grok",
      "/home/collin/project/.claude",
      "/home/collin/project/.gemini",
      "/home/collin/.codex/AGENTS.md",
      "/home/collin/.claude/CLAUDE.md",
      "/home/collin/.gemini/GEMINI.md",
      "/home/collin/.grok",
      "/home/collin/.claude",
      "/home/collin/.gemini",
    ]);
  });

  it("builds all twelve candidates for a Windows-style cwd/home, using backslashes", () => {
    const files = ruleFileCandidates("C:\\Users\\collin\\project", "C:\\Users\\collin");
    expect(files.map((f) => f.path)).toEqual([
      "C:\\Users\\collin\\project\\AGENTS.md",
      "C:\\Users\\collin\\project\\CLAUDE.md",
      "C:\\Users\\collin\\project\\GEMINI.md",
      "C:\\Users\\collin\\project\\.grok",
      "C:\\Users\\collin\\project\\.claude",
      "C:\\Users\\collin\\project\\.gemini",
      "C:\\Users\\collin\\.codex\\AGENTS.md",
      "C:\\Users\\collin\\.claude\\CLAUDE.md",
      "C:\\Users\\collin\\.gemini\\GEMINI.md",
      "C:\\Users\\collin\\.grok",
      "C:\\Users\\collin\\.claude",
      "C:\\Users\\collin\\.gemini",
    ]);
  });

  it("tolerates a trailing separator on cwd/home", () => {
    const files = ruleFileCandidates("/home/collin/project/", "/home/collin/");
    expect(files[0].path).toBe("/home/collin/project/AGENTS.md");
    expect(files[9].path).toBe("/home/collin/.grok");
  });

  it("returns only project candidates when home is empty, and vice versa", () => {
    expect(ruleFileCandidates("/home/collin/project", "")).toHaveLength(6);
    expect(ruleFileCandidates("", "/home/collin")).toHaveLength(6);
    expect(ruleFileCandidates("", "")).toEqual([]);
  });

  it("marks every candidate exists:false and scope/kind correctly, with no guessed provider list empty", () => {
    const files = ruleFileCandidates("/proj", "/home");
    for (const f of files) expect(f.exists).toBe(false);
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(byPath["/proj/AGENTS.md"]).toMatchObject({ scope: "project", kind: "file", providers: ["codex", "grok"] });
    expect(byPath["/proj/CLAUDE.md"]).toMatchObject({ scope: "project", kind: "file", providers: ["claude", "grok"] });
    expect(byPath["/proj/GEMINI.md"]).toMatchObject({ scope: "project", kind: "file", providers: ["gemini"] });
    expect(byPath["/proj/.grok"]).toMatchObject({ scope: "project", kind: "directory", providers: ["grok"] });
    expect(byPath["/proj/.claude"]).toMatchObject({ scope: "project", kind: "directory", providers: ["claude", "grok"] });
    expect(byPath["/proj/.gemini"]).toMatchObject({ scope: "project", kind: "directory", providers: ["gemini"] });
    expect(byPath["/home/.codex/AGENTS.md"]).toMatchObject({ scope: "global", kind: "file", providers: ["codex"] });
    expect(byPath["/home/.claude/CLAUDE.md"]).toMatchObject({ scope: "global", kind: "file", providers: ["claude"] });
    expect(byPath["/home/.gemini/GEMINI.md"]).toMatchObject({ scope: "global", kind: "file", providers: ["gemini"] });
    expect(byPath["/home/.grok"]).toMatchObject({ scope: "global", kind: "directory", providers: ["grok"] });
    expect(byPath["/home/.claude"]).toMatchObject({ scope: "global", kind: "directory", providers: ["claude"] });
    expect(byPath["/home/.gemini"]).toMatchObject({ scope: "global", kind: "directory", providers: ["gemini"] });
  });
});

describe("buildRuleAppend", () => {
  const DATE = "2026-09-08";

  it("writes just the marker block when the file is empty", () => {
    expect(buildRuleAppend("", "Use 2-space indentation.", DATE)).toBe(
      "<!-- Added via All your Companions on 2026-09-08 -->\nUse 2-space indentation.\n",
    );
  });

  it("adds exactly one blank line before the separator when existing content has none", () => {
    expect(buildRuleAppend("# Project rules\n", "New rule.", DATE)).toBe(
      "# Project rules\n\n---\n<!-- Added via All your Companions on 2026-09-08 -->\nNew rule.\n",
    );
  });

  it("adds a trailing newline before separating when existing content has none at all", () => {
    expect(buildRuleAppend("# Project rules", "New rule.", DATE)).toBe(
      "# Project rules\n\n---\n<!-- Added via All your Companions on 2026-09-08 -->\nNew rule.\n",
    );
  });

  it("does not add a second blank line when one already trails the file", () => {
    expect(buildRuleAppend("# Project rules\n\n", "New rule.", DATE)).toBe(
      "# Project rules\n\n---\n<!-- Added via All your Companions on 2026-09-08 -->\nNew rule.\n",
    );
  });

  it("trims surrounding whitespace off the addition but never touches existing bytes", () => {
    const existing = "Line one.\nLine two.\n";
    const result = buildRuleAppend(existing, "  \n  Selected text.  \n\n", DATE);
    expect(result.startsWith(existing)).toBe(true);
    expect(result).toBe(
      "Line one.\nLine two.\n\n---\n<!-- Added via All your Companions on 2026-09-08 -->\nSelected text.\n",
    );
  });

  it("is a no-op for a blank/whitespace-only addition", () => {
    expect(buildRuleAppend("existing\n", "   \n  ", DATE)).toBe("existing\n");
    expect(buildRuleAppend("existing\n", "", DATE)).toBe("existing\n");
  });
});

/** In-memory fake matching {@link RuleFileFs}. */
function makeFakeFs(initial: Record<string, { text?: string; isDirectory?: boolean } | undefined> = {}): RuleFileFs & {
  files: Record<string, { text?: string; isDirectory?: boolean } | undefined>;
  writes: string[];
} {
  const files: Record<string, { text?: string; isDirectory?: boolean } | undefined> = { ...initial };
  const writes: string[] = [];
  return {
    files,
    writes,
    async stat(absPath) {
      const entry = files[absPath];
      if (!entry) return undefined;
      return { isDirectory: !!entry.isDirectory, size: entry.text ? entry.text.length : 0 };
    },
    async readText(absPath) {
      const entry = files[absPath];
      return entry && !entry.isDirectory ? entry.text ?? "" : undefined;
    },
    async writeText(absPath, content) {
      writes.push(absPath);
      files[absPath] = { text: content };
    },
    async mkdir(absPath) {
      if (!files[absPath]) files[absPath] = { isDirectory: true };
    },
  };
}

const FILE: RuleFile = {
  path: "/proj/AGENTS.md",
  label: "AGENTS.md (project)",
  scope: "project",
  kind: "file",
  providers: ["codex", "grok"],
  exists: false,
};
const DIR: RuleFile = {
  path: "/proj/.grok",
  label: ".grok/ (project)",
  scope: "project",
  kind: "directory",
  providers: ["grok"],
  exists: false,
};

describe("resolveRuleFileStates", () => {
  it("fills exists/bytes for files, exists-only for directories, and false for missing entries", async () => {
    const fs = makeFakeFs({
      "/proj/AGENTS.md": { text: "hello" },
      "/proj/.grok": { isDirectory: true },
    });
    const resolved = await resolveRuleFileStates([FILE, DIR], fs);
    expect(resolved[0]).toMatchObject({ exists: true, bytes: 5 });
    expect(resolved[1]).toMatchObject({ exists: true, bytes: undefined });
  });

  it("treats a stat rejection the same as ENOENT — exists:false, never thrown", async () => {
    const fs: RuleFileFs = {
      stat: vi.fn().mockRejectedValue(new Error("EPERM")),
      readText: vi.fn(),
      writeText: vi.fn(),
      mkdir: vi.fn(),
    };
    const resolved = await resolveRuleFileStates([FILE], fs);
    expect(resolved[0].exists).toBe(false);
    expect(resolved[0].bytes).toBeUndefined();
  });
});

describe("ensureRuleFile", () => {
  it("creates parent directories and an empty file when a file candidate is missing", async () => {
    const fs = makeFakeFs();
    await ensureRuleFile(FILE, fs);
    expect(fs.files["/proj/AGENTS.md"]?.text).toBe("");
    expect(fs.files["/proj"]?.isDirectory).toBe(true);
  });

  it("never writes when the file already exists", async () => {
    const fs = makeFakeFs({ "/proj/AGENTS.md": { text: "already here" } });
    await ensureRuleFile(FILE, fs);
    expect(fs.writes).toEqual([]);
    expect(fs.files["/proj/AGENTS.md"]?.text).toBe("already here");
  });

  it("mkdirs a missing directory candidate instead of writing a file", async () => {
    const fs = makeFakeFs();
    await ensureRuleFile(DIR, fs);
    expect(fs.files["/proj/.grok"]?.isDirectory).toBe(true);
    expect(fs.writes).toEqual([]);
  });

  it("is a no-op when the directory candidate already exists", async () => {
    const fs = makeFakeFs({ "/proj/.grok": { isDirectory: true } });
    await ensureRuleFile(DIR, fs);
    expect(fs.writes).toEqual([]);
  });
});

describe("appendRuleEntry", () => {
  const DATE = "2026-09-08";

  it("creates a missing file with just the marker block", async () => {
    const fs = makeFakeFs();
    await appendRuleEntry(FILE, "Always run npm test first.", DATE, fs);
    expect(fs.files["/proj/AGENTS.md"]?.text).toBe(
      "<!-- Added via All your Companions on 2026-09-08 -->\nAlways run npm test first.\n",
    );
    expect(fs.writes).toEqual(["/proj/AGENTS.md"]);
  });

  it("appends after existing content in exactly one write, never altering it", async () => {
    const fs = makeFakeFs({ "/proj/AGENTS.md": { text: "# Rules\n\n- Be nice\n" } });
    await appendRuleEntry(FILE, "New rule.", DATE, fs);
    expect(fs.files["/proj/AGENTS.md"]?.text).toBe(
      "# Rules\n\n- Be nice\n\n---\n<!-- Added via All your Companions on 2026-09-08 -->\nNew rule.\n",
    );
    expect(fs.writes).toEqual(["/proj/AGENTS.md"]);
  });

  it("skips the write entirely for a blank selection", async () => {
    const fs = makeFakeFs({ "/proj/AGENTS.md": { text: "unchanged\n" } });
    await appendRuleEntry(FILE, "   \n  ", DATE, fs);
    expect(fs.writes).toEqual([]);
    expect(fs.files["/proj/AGENTS.md"]?.text).toBe("unchanged\n");
  });

  it("rejects a directory-kind target instead of writing anything", async () => {
    const fs = makeFakeFs();
    await expect(appendRuleEntry(DIR, "text", DATE, fs)).rejects.toThrow(/file-kind/);
    expect(fs.writes).toEqual([]);
  });

  it("propagates a read-only write failure with no partial write — the file keeps its prior content", async () => {
    const existingText = "# Rules\n- Be nice\n";
    const fs: RuleFileFs = {
      stat: vi.fn().mockResolvedValue({ isDirectory: false, size: existingText.length }),
      readText: vi.fn().mockResolvedValue(existingText),
      writeText: vi.fn().mockRejectedValue(new Error("EACCES: permission denied")),
      mkdir: vi.fn().mockResolvedValue(undefined),
    };
    await expect(appendRuleEntry(FILE, "New rule.", DATE, fs)).rejects.toThrow(/EACCES/);
    // writeText was attempted exactly once, with the FULL final content — a
    // real fs call either lands whole or not at all, never half-written.
    expect(fs.writeText).toHaveBeenCalledTimes(1);
    expect(fs.writeText).toHaveBeenCalledWith(
      "/proj/AGENTS.md",
      "# Rules\n- Be nice\n\n---\n<!-- Added via All your Companions on 2026-09-08 -->\nNew rule.\n",
    );
  });
});
