import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  MENTION_INDEX_LIMIT,
  MENTION_INDEX_LIMIT_MIN,
  MENTION_RESULT_LIMIT,
  buildExcludeGlob,
  clampMentionIndexLimit,
  filterMentionFiles,
  mergeMentionEntries,
  normalizeRelPath,
  orderMentionIndex,
  resolveMentionFallback,
  resolveMentionAttachmentPath,
  isMentionPathInsideWorkspace,
} from "../src/mention";
// The webview half of the feature (token detection + pick rewrite) lives in the
// shared plain-JS helpers so chat.js and the tests exercise the same code.
import { getMentionQuery, applyMentionPick } from "../media/webview-helpers.js";

describe("mention attachment workspace boundary", () => {
  it("resolves an ordinary workspace-relative fallback", () => {
    expect(resolveMentionFallback("/work/repo", "docs/notes.md", "linux"))
      .toBe("/work/repo/docs/notes.md");
  });

  it("rejects parent traversal and absolute fallback paths", () => {
    expect(resolveMentionFallback("/work/repo", "../../secret.png", "linux")).toBeUndefined();
    expect(resolveMentionFallback("/work/repo", "/etc/passwd", "linux")).toBeUndefined();
  });

  it("uses segment boundaries rather than string prefixes", () => {
    expect(isMentionPathInsideWorkspace("/work/repo", "/work/repo-file/x.png", "linux")).toBe(false);
    expect(isMentionPathInsideWorkspace("/work/repo", "/work/repo/.cache/x.png", "linux")).toBe(true);
  });

  it("uses case-insensitive Windows path semantics", () => {
    expect(isMentionPathInsideWorkspace("C:\\Work\\Repo", "c:\\work\\repo\\docs\\a.md", "win32")).toBe(true);
    expect(isMentionPathInsideWorkspace("C:\\Work\\Repo", "C:\\Work\\Repo2\\a.md", "win32")).toBe(false);
    expect(resolveMentionFallback("C:\\Work\\Repo", "..\\..\\secret.png", "win32")).toBeUndefined();
  });

  it("can validate canonical paths after realpath resolves symlinks", () => {
    const root = path.posix.resolve("/work/repo");
    expect(isMentionPathInsideWorkspace(root, "/work/repo/real/file.md", "linux")).toBe(true);
    // A lexical `/work/repo/link.png` may resolve here; canonical comparison rejects it.
    expect(isMentionPathInsideWorkspace(root, "/outside/secret.png", "linux")).toBe(false);
  });

  it("prefers the host catalog, then an open tab, then the workspace fallback", () => {
    expect(resolveMentionAttachmentPath(
      "/work/repo", "docs/a.md", "/work/repo/docs/a.md", "/work/repo/other.md", "linux",
    )).toBe("/work/repo/docs/a.md");
    expect(resolveMentionAttachmentPath("/work/repo", "docs/a.md", undefined, "/work/repo/open.md", "linux"))
      .toBe("/work/repo/open.md");
    expect(resolveMentionAttachmentPath("/work/repo", "docs/a.md", undefined, undefined, "linux"))
      .toBe("/work/repo/docs/a.md");
  });
});

describe("getMentionQuery (webview token detection)", () => {
  it("triggers on @ at the start of the text", () => {
    expect(getMentionQuery("@", 1)).toBe("");
    expect(getMentionQuery("@src", 4)).toBe("src");
  });

  it("triggers after whitespace and newlines", () => {
    expect(getMentionQuery("fix @ch", 7)).toBe("ch");
    expect(getMentionQuery("line one\n@te", 12)).toBe("te");
    expect(getMentionQuery("a\t@x", 4)).toBe("x");
  });

  it("does not trigger mid-word (emails, handles)", () => {
    expect(getMentionQuery("user@host", 9)).toBeNull();
    expect(getMentionQuery("a@b", 3)).toBeNull();
  });

  it("is caret-anchored: text after the caret is ignored", () => {
    // Caret right after "@s" — the trailing prose doesn't kill the token.
    expect(getMentionQuery("@s and more", 2)).toBe("s");
    // Caret in the prose after the token's closing space — no token.
    expect(getMentionQuery("@src/a.ts done", 14)).toBeNull();
  });

  it("closes on whitespace and on a second @", () => {
    expect(getMentionQuery("@src ", 5)).toBeNull();
    expect(getMentionQuery("@a@b", 4)).toBeNull(); // second @ isn't whitespace-preceded
  });

  it("allows path characters in the token", () => {
    expect(getMentionQuery("@src/chips.ts", 13)).toBe("src/chips.ts");
    expect(getMentionQuery("@.github/ci", 11)).toBe(".github/ci");
  });
});

describe("applyMentionPick (webview pick rewrite)", () => {
  it("replaces the partial token with @relPath and a trailing space", () => {
    const r = applyMentionPick("@ch", 3, "src/chips.ts");
    expect(r.text).toBe("@src/chips.ts ");
    expect(r.caret).toBe(14);
  });

  it("preserves text before and after the caret", () => {
    const r = applyMentionPick("fix @ch please", 7, "src/chips.ts");
    expect(r.text).toBe("fix @src/chips.ts  please");
    expect(r.caret).toBe("fix @src/chips.ts ".length);
  });

  it("handles a bare @ (empty token)", () => {
    const r = applyMentionPick("see @", 5, "a.ts");
    expect(r.text).toBe("see @a.ts ");
    expect(r.caret).toBe(10);
  });

  it("does not misread $ sequences in a path as replace directives", () => {
    const r = applyMentionPick("@p", 2, "src/$&weird$'.ts");
    expect(r.text).toBe("@src/$&weird$'.ts ");
  });
});

describe("filterMentionFiles (host ranking)", () => {
  const files = [
    "README.md",
    "src/chips.ts",
    "src/chat-helpers.ts",
    "media/chat.js",
    "test/chips.test.ts",
    "docs/architecture.md",
  ];

  it("empty query passes the index through (capped)", () => {
    expect(filterMentionFiles(files, "")).toEqual(files);
    expect(filterMentionFiles(files, "", 2)).toEqual(["README.md", "src/chips.ts"]);
  });

  it("ranks basename prefix above basename substring above path substring", () => {
    const ranked = filterMentionFiles(files, "chat");
    // Prefix on basename: chat.js + chat-helpers.ts (shorter path first);
    // then nothing else matches "chat" in these fixtures.
    expect(ranked[0]).toBe("media/chat.js");
    expect(ranked[1]).toBe("src/chat-helpers.ts");
  });

  it("matches directory-qualified queries via the path tier", () => {
    expect(filterMentionFiles(files, "src/ch")).toEqual(["src/chips.ts", "src/chat-helpers.ts"]);
  });

  it("is case-insensitive", () => {
    expect(filterMentionFiles(files, "readme")).toEqual(["README.md"]);
    expect(filterMentionFiles(files, "CHIPS")[0]).toBe("src/chips.ts");
  });

  it("falls back to in-order subsequence matching", () => {
    // "darch" is not a substring of docs/architecture.md but is a subsequence.
    expect(filterMentionFiles(files, "darch")).toEqual(["docs/architecture.md"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterMentionFiles(files, "zzz-nope")).toEqual([]);
  });

  it("caps results at the limit", () => {
    const many = Array.from({ length: 100 }, (_, i) => `src/f${String(i).padStart(3, "0")}.ts`);
    expect(filterMentionFiles(many, "f").length).toBe(MENTION_RESULT_LIMIT);
    expect(filterMentionFiles(many, "f", 5).length).toBe(5);
  });

  it("prefers the shorter path within a tier", () => {
    const ranked = filterMentionFiles(["deep/nested/dir/chips.ts", "src/chips.ts"], "chips");
    expect(ranked).toEqual(["src/chips.ts", "deep/nested/dir/chips.ts"]);
  });
});

describe("buildExcludeGlob", () => {
  it("always excludes node_modules and .git", () => {
    expect(buildExcludeGlob([])).toBe("{**/node_modules/**,**/.git/**}");
    expect(buildExcludeGlob([undefined, undefined])).toBe("{**/node_modules/**,**/.git/**}");
  });

  it("merges only true-valued patterns from the config maps", () => {
    const glob = buildExcludeGlob([
      { "**/out/**": true, "**/keep/**": false },
      // files.exclude values can be `{ when: … }` clause objects — not `true`.
      { "**/dist/**": true, "**/*.meta": { when: "$(basename)" } as unknown },
    ] as Array<Record<string, unknown>>);
    expect(glob).toContain("**/out/**");
    expect(glob).toContain("**/dist/**");
    expect(glob).not.toContain("keep");
    expect(glob).not.toContain("*.meta");
  });

  it("dedupes a pattern present in both maps", () => {
    const glob = buildExcludeGlob([{ "**/out/**": true }, { "**/out/**": true }]);
    expect(glob.match(/\*\*\/out\/\*\*/g)?.length).toBe(1);
  });
});

describe("orderMentionIndex / normalizeRelPath", () => {
  it("orders shallow-first, then alphabetical", () => {
    expect(orderMentionIndex(["src/z.ts", "b.md", "a.md", "src/a/deep.ts"])).toEqual([
      "a.md",
      "b.md",
      "src/z.ts",
      "src/a/deep.ts",
    ]);
  });

  it("does not mutate its input", () => {
    const input = ["b.md", "a.md"];
    orderMentionIndex(input);
    expect(input).toEqual(["b.md", "a.md"]);
  });

  it("normalizeRelPath converts backslashes", () => {
    expect(normalizeRelPath("src\\a\\b.ts")).toBe("src/a/b.ts");
    expect(normalizeRelPath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("clampMentionIndexLimit (#69)", () => {
  it("passes through a sane user value", () => {
    expect(clampMentionIndexLimit(20000)).toBe(20000);
    expect(clampMentionIndexLimit(MENTION_INDEX_LIMIT_MIN)).toBe(MENTION_INDEX_LIMIT_MIN);
  });

  it("has no upper bound — a monorepo may index everything", () => {
    expect(clampMentionIndexLimit(5_000_000)).toBe(5_000_000);
  });

  it("floors below the minimum, so the popover can't be made useless", () => {
    expect(clampMentionIndexLimit(1)).toBe(MENTION_INDEX_LIMIT_MIN);
    expect(clampMentionIndexLimit(99)).toBe(MENTION_INDEX_LIMIT_MIN);
  });

  it("truncates a fractional value to an integer (findFiles wants a count)", () => {
    expect(clampMentionIndexLimit(1234.9)).toBe(1234);
  });

  it("falls back to the default for junk, not to zero — zero would empty the index", () => {
    for (const junk of [undefined, null, NaN, Infinity, -Infinity, 0, -5, "abc", {}, []]) {
      expect(clampMentionIndexLimit(junk)).toBe(MENTION_INDEX_LIMIT);
    }
  });

  it("accepts a numeric string (settings.json can hold one)", () => {
    expect(clampMentionIndexLimit("8000")).toBe(8000);
  });
});

describe("mergeMentionEntries (open editors layered onto the findFiles snapshot, #69)", () => {
  const base = () => new Map([["src/a.ts", "/w/src/a.ts"]]);

  it("returns the SAME map instance when nothing is new — the cached snapshot stays untouched", () => {
    const m = base();
    expect(mergeMentionEntries(m, [])).toBe(m);
    expect(mergeMentionEntries(m, [{ rel: "src/a.ts", abs: "/w/src/a.ts" }])).toBe(m);
  });

  it("copies rather than mutates when something is added", () => {
    const m = base();
    const out = mergeMentionEntries(m, [{ rel: "src/b.ts", abs: "/w/src/b.ts" }]);
    expect(out).not.toBe(m);
    expect(m.size).toBe(1); // the cached snapshot must not grow
    expect(out.get("src/b.ts")).toBe("/w/src/b.ts");
  });

  it("first wins — an open tab never overwrites the findFiles path for the same rel", () => {
    const out = mergeMentionEntries(base(), [{ rel: "src/a.ts", abs: "/elsewhere/a.ts" }]);
    expect(out.get("src/a.ts")).toBe("/w/src/a.ts");
  });

  it("dedupes within the extra entries themselves", () => {
    const out = mergeMentionEntries(base(), [
      { rel: "src/b.ts", abs: "/w/src/b.ts" },
      { rel: "src/b.ts", abs: "/other/b.ts" },
    ]);
    expect(out.get("src/b.ts")).toBe("/w/src/b.ts");
    expect(out.size).toBe(2);
  });

  it("skips entries missing either half instead of poisoning the index", () => {
    const m = base();
    expect(mergeMentionEntries(m, [{ rel: "", abs: "/w/x.ts" }, { rel: "x.ts", abs: "" }])).toBe(m);
  });

  it("adds the #69 case: a file past the findFiles cap but open as a tab", () => {
    const snapshot = new Map<string, string>();
    for (let i = 0; i < 10; i++) snapshot.set(`noise/${i}.ts`, `/w/noise/${i}.ts`);
    const merged = mergeMentionEntries(snapshot, [
      { rel: "src/AreaExtensions.cs", abs: "/w/src/AreaExtensions.cs" },
    ]);
    // The whole point: it must now be reachable by the `@` ranking.
    const hits = filterMentionFiles(orderMentionIndex([...merged.keys()]), "AreaExt");
    expect(hits).toContain("src/AreaExtensions.cs");
  });
});
