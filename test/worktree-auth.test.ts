/**
 * ACP worktree path validation before cache / auth roots.
 *
 * Mutation-checked: an unlisted worktree path is refused.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLONE_WORKTREE_SOURCE_MARKER,
  cloneWorktreeSourceMatches,
  filterWorktreesForSourceRepo,
  mergeWorktreeRefresh,
  parseGitWorktreeListPorcelain,
  worktreePathAuthorizedForRepo,
  worktreeStatusIsForCreate,
  worktreeStatusVerdict,
  type WorktreeRecord,
} from "../src/worktree";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function rec(partial: Partial<WorktreeRecord> & { path: string; sourceRepo?: string }): WorktreeRecord {
  return {
    id: partial.id ?? partial.path,
    path: partial.path,
    sourceRepo: partial.sourceRepo ?? "",
    repoName: partial.repoName ?? "r",
    kind: partial.kind ?? "session",
    creationMode: partial.creationMode ?? "linked",
    gitRef: partial.gitRef ?? "HEAD",
    headCommit: partial.headCommit ?? "",
    status: partial.status ?? "alive",
    label: partial.label ?? "l",
    userProvidedLabel: partial.userProvidedLabel ?? false,
  };
}

describe("worktreePathAuthorizedForRepo", () => {
  const source = "/repos/app";
  const listed = ["/repos/app", "/home/u/.grok/worktrees/app/feat"];

  it("accepts a path that appears in the authoritative list for the repo", () => {
    expect(
      worktreePathAuthorizedForRepo({
        worktreePath: "/home/u/.grok/worktrees/app/feat",
        sourceRepo: source,
        listedWorktreePaths: listed,
        claimedSourceGitRoot: source,
        sourceGitRoot: source,
      }),
    ).toBe(true);
  });

  it("refuses a path not in the worktree list (compromised ACP create)", () => {
    expect(
      worktreePathAuthorizedForRepo({
        worktreePath: "/evil/outside",
        sourceRepo: source,
        listedWorktreePaths: listed,
        claimedSourceGitRoot: source,
      }),
    ).toBe(false);
  });

  it("refuses when claimed sourceGitRoot does not match the requested repo", () => {
    expect(
      worktreePathAuthorizedForRepo({
        worktreePath: "/home/u/.grok/worktrees/app/feat",
        sourceRepo: source,
        listedWorktreePaths: listed,
        claimedSourceGitRoot: "/evil/other-repo",
        sourceGitRoot: source,
      }),
    ).toBe(false);
  });

  it("refuses the main checkout path as a 'created' worktree", () => {
    expect(
      worktreePathAuthorizedForRepo({
        worktreePath: source,
        sourceRepo: source,
        listedWorktreePaths: listed,
      }),
    ).toBe(false);
  });
});

describe("filterWorktreesForSourceRepo / mergeWorktreeRefresh", () => {
  it("drops records without sourceRepo or with the wrong source", () => {
    const refreshed = [
      rec({ path: "/wt/good", sourceRepo: "/repos/app" }),
      rec({ path: "/wt/evil", sourceRepo: "/repos/other" }),
      rec({ path: "/wt/orphan" }), // no sourceRepo
    ];
    const kept = filterWorktreesForSourceRepo(refreshed, "/repos/app");
    expect(kept.map((r) => r.path)).toEqual(["/wt/good"]);
  });

  it("mergeWorktreeRefresh does not inject unattributed rows into the cache", () => {
    const current: WorktreeRecord[] = [
      rec({ path: "/wt/old", sourceRepo: "/repos/app" }),
    ];
    const merged = mergeWorktreeRefresh(current, "/repos/app", [
      rec({ path: "/wt/new", sourceRepo: "/repos/app" }),
      rec({ path: "/evil", sourceRepo: "" }),
      rec({ path: "/other", sourceRepo: "/repos/other" }),
    ]);
    expect(merged.map((r) => r.path).sort()).toEqual(["/wt/new"].sort());
  });
});

describe("parseGitWorktreeListPorcelain", () => {
  it("extracts worktree paths from porcelain output", () => {
    const stdout = [
      "worktree /repos/app",
      "HEAD abc",
      "branch refs/heads/main",
      "",
      "worktree /home/u/.grok/worktrees/app/feat",
      "HEAD def",
      "detached",
      "",
    ].join("\n");
    expect(parseGitWorktreeListPorcelain(stdout)).toEqual([
      "/repos/app",
      "/home/u/.grok/worktrees/app/feat",
    ]);
  });
});

describe("sidebar create path validates before cache (source)", () => {
  it("create worktree calls worktreePathAuthorizedForRepo before cache push", () => {
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    expect(src).toContain("worktreePathAuthorizedForRepo");
    expect(src).toContain("listAuthoritativeWorktreePaths");
    expect(src).toContain("listGitWorktreePaths");
    // git spawn lives outside sidebar (cli-process gate: no execFile in sidebar).
    expect(src).toMatch(/from\s+["']\.\/git-worktree-list["']/);

    const createStart = src.indexOf("Creating git worktree");
    // From create progress through the cache push it guards. Bounded by the
    // push itself, not by a character count — a fixed window silently stops
    // covering the code it is about the moment a comment grows.
    const createRegion = src.slice(
      createStart,
      src.indexOf("this.worktreeCache.push", createStart) + 40,
    );
    const authIdx = createRegion.indexOf("worktreePathAuthorizedForRepo");
    const cachePush = createRegion.indexOf("this.worktreeCache.push");
    expect(authIdx).toBeGreaterThan(0);
    expect(cachePush).toBeGreaterThan(authIdx);

    // Mutation: if we pushed to cache before validation, order flips.
    expect(cachePush).toBeGreaterThan(authIdx);
  });
});

/**
 * Clone-mode worktrees.
 *
 * Not every "worktree" the CLI produces is a `git worktree add`. For some repos
 * it makes a standalone clone — its `.git` is a real directory with its own
 * object store — and the source repo's `git worktree list` will never mention
 * it. The owner hit exactly that: the checkout was created, refused as "not in
 * git worktree list", and left on disk; the retry that "worked" only passed
 * because the ACP list was trusted on its own, and what it waved through was an
 * empty directory that grok then exited 1 inside.
 *
 * So the provenance marker the CLI writes is the second form of proof — read
 * from local disk by us, never taken from the agent.
 */
describe("worktree status correlation (the real decision, not its source text)", () => {
  const WT = "/home/u/.grok/worktrees/app/feat";
  const OTHER = "/home/u/.grok/worktrees/app/other";

  it("accepts a terminal event naming our worktree", () => {
    expect(
      worktreeStatusIsForCreate(
        { worktreePath: WT },
        { target: WT, soleCreateInFlight: false },
      ),
    ).toBe(true);
  });

  it("rejects a terminal event naming a DIFFERENT worktree", () => {
    // The bug this closes: one create's completion released another's wait,
    // and that flow then started in a checkout still being copied.
    expect(
      worktreeStatusIsForCreate(
        { worktreePath: OTHER },
        { target: WT, soleCreateInFlight: true },
      ),
    ).toBe(false);
  });

  it("accepts a PATHLESS progress event only while ours is the sole create", () => {
    // Progress notifications carry no path at all, so attribution rests
    // entirely on there being one create it could belong to.
    expect(worktreeStatusIsForCreate({}, { target: WT, soleCreateInFlight: true })).toBe(true);
    expect(worktreeStatusIsForCreate({}, { target: WT, soleCreateInFlight: false })).toBe(false);
  });

  it("rejects a named event before the path is known", () => {
    // Events can arrive before the create RPC has answered; they are buffered
    // and replayed, never matched against nothing.
    expect(worktreeStatusIsForCreate({ worktreePath: WT }, { soleCreateInFlight: false })).toBe(
      false,
    );
  });

  it("reads only terminal statuses as an outcome", () => {
    expect(worktreeStatusVerdict({ status: "created" })).toBe("created");
    expect(worktreeStatusVerdict({ status: "done" })).toBe("created");
    expect(worktreeStatusVerdict({ status: "failed" })).toBe("failed");
    expect(worktreeStatusVerdict({ status: "error" })).toBe("failed");
    // Progress is what proves the CLI speaks the protocol, and must NOT settle
    // the wait — that distinction is what separates "old CLI" from "stalled".
    expect(worktreeStatusVerdict({ status: "progress" })).toBeUndefined();
    expect(worktreeStatusVerdict({})).toBeUndefined();
    expect(worktreeStatusVerdict(null)).toBeUndefined();
  });
});

describe("cloneWorktreeSourceMatches", () => {
  // The owner's real paths — note the lowercase drive letter in the marker the
  // CLI wrote against the uppercase one in the worktree path. Windows treats
  // them as the same place and so must this.
  const SOURCE = String.raw`c:\GitHub\accredia`;
  const WT = String.raw`C:\Users\Dell\.grok\worktrees\github-accredia\worktree-test`;
  const winJoin = (a: string, b: string) => `${a}\\${b.split("/").join("\\")}`;
  const reader = (contents: Record<string, string>) => (p: string) => {
    const hit = contents[p];
    if (hit === undefined) throw new Error("ENOENT: no such file");
    return hit;
  };
  const marker = (dir: string) => winJoin(dir, CLONE_WORKTREE_SOURCE_MARKER);
  const call = (opts: { source?: string; gitRoot?: string; contents?: Record<string, string> }) =>
    cloneWorktreeSourceMatches({
      worktreePath: WT,
      sourceRepo: opts.source ?? SOURCE,
      sourceGitRoot: opts.gitRoot,
      readMarker: reader(opts.contents ?? {}),
      joinPath: winJoin,
    });

  it("accepts a marker naming the source repo", () => {
    expect(call({ contents: { [marker(WT)]: `${SOURCE}\n` } })).toBe(true);
  });

  it("accepts a marker naming the git root when the project is a subfolder", () => {
    expect(
      call({
        source: String.raw`c:\GitHub\accredia\packages\app`,
        gitRoot: SOURCE,
        contents: { [marker(WT)]: SOURCE },
      }),
    ).toBe(true);
  });

  it("refuses a marker naming a DIFFERENT repo", () => {
    // The whole point: a path the agent claims is a worktree of this repo, but
    // whose own on-disk record says it came from somewhere else.
    expect(call({ contents: { [marker(WT)]: String.raw`c:\GitHub\some-other-repo` } })).toBe(false);
  });

  it("refuses when there is no marker at all", () => {
    // An empty directory the CLI left behind reads exactly like this.
    expect(call({})).toBe(false);
  });

  it("refuses an empty or self-referential marker", () => {
    expect(call({ contents: { [marker(WT)]: "   \n" } })).toBe(false);
    expect(call({ contents: { [marker(WT)]: WT } })).toBe(false);
  });
});

describe("worktree validation reads git first", () => {
  it("never returns an ACP path git has not confirmed, without proof of its own", () => {
    // The regression that shipped: `listAuthoritativeWorktreePaths` returned the
    // agent's list verbatim whenever it had any attributed row, and consulted
    // git only when that list was EMPTY. The guard's whole job is to confirm the
    // agent's claim, and it was satisfied by the claim.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private async listAuthoritativeWorktreePaths");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  private ", start + 40));
    // git runs unconditionally, before any use of the ACP answer.
    const gitAt = body.indexOf("listGitWorktreePaths");
    const acpAt = body.indexOf("client.listWorktrees");
    expect(gitAt).toBeGreaterThan(-1);
    expect(acpAt).toBeGreaterThan(gitAt);
    // Every ACP row that gets added has to clear the provenance check.
    expect(body).toMatch(/cloneWorktreeBelongsTo\([^)]*\)\)\s*add\(/);
  });

  it("a directory with no .git is never 'ready'", () => {
    // waitForWorktreeReady used to fall back to `existsSync(worktreePath)` on
    // timeout, so an empty folder counted as a checkout and grok was spawned in
    // it. That is the `grok exited with code 1` in the owner's log.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private async waitForWorktreeReady");
    const body = src.slice(start, src.indexOf("\n  }", start) + 4);
    expect(body).toContain('path.join(worktreePath, ".git")');
    expect(body).not.toMatch(/return fs\.existsSync\(worktreePath\)/);
  });

  it("self-removal is fenced by location AND one positive answer", () => {
    // The fallback for "Remove worktree failed: Internal error" is a recursive
    // delete, so the fence is worth pinning: grok's own root, never an open
    // folder or the source repo, and then either nothing-to-lose (gone or
    // empty) or a marker naming this repo.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private canSelfRemoveWorktree");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  /**", start));
    expect(body).toContain('path.join(resolveGrokHome(), "worktrees")');
    expect(body).toContain("relativePathWithin");
    expect(body).toContain("openWorkspaceFolders");
    expect(body).toContain("cloneWorktreeBelongsTo");
    // An empty directory has nothing to lose, and it is the case that kept the
    // owner stuck: the CLI deletes the contents and THEN fails on the
    // bookkeeping, so by the time it reports the error there is no marker left
    // to prove anything with. Refusing there refuses to delete an empty folder
    // the user explicitly asked to delete.
    expect(body).toContain("readdirSync");
    expect(body).toContain("if (!contents.length) return undefined");
  });

  it("refusals carry a reason, and the reason reaches the user", () => {
    // "Remove worktree failed: Internal error" with nothing after it is what
    // this round cost. A refusal has to say what it refused on.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private canSelfRemoveWorktree");
    const body = src.slice(start, src.indexOf("\n  /**", start));
    expect(body).toContain(": string | undefined {");
    expect(body).toContain("return `it is outside");
    const remove = src.slice(src.indexOf("async removeFocusedWorktree"));
    expect(remove.slice(0, remove.indexOf("this.worktreeCache = "))).toContain(
      "was left alone because",
    );
  });

  it("requires the clone to live under grok's own worktrees root", () => {
    // A marker is a FILE, so whoever proposed the path can write one. On its
    // own it proves the proposer touched that directory, not that we made it —
    // and accepting it ends with a grok process running there, the path
    // persisted on the session, and the path in the trusted-cwd set a linked
    // remote may target. Location has to come first, canonically, or a symlink
    // planted inside the root satisfies a textual prefix check.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private cloneWorktreeBelongsTo");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  }", start));
    const fence = body.indexOf("isCanonicallyInsideRoot");
    const marker = body.indexOf("cloneWorktreeSourceMatches");
    expect(fence, "location fence must exist").toBeGreaterThan(-1);
    expect(marker, "and the marker check after it").toBeGreaterThan(fence);
    expect(body).toContain('path.join(resolveGrokHome(), "worktrees")');
  });

  it("derives the git root locally and treats the response as a claim", () => {
    // This check used to answer itself: `created.sourceGitRoot` was taken as
    // the root to query AND handed back as the claim to compare against, so it
    // always matched. A response naming repository B could hand back a genuine
    // worktree OF B, have git truthfully list it, and be filed under A.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("Creating git worktree");
    const region = src.slice(start, src.indexOf("this.worktreeCache.push", start));
    expect(region).toContain("const sourceGitRoot = gitRootForPath(sourcePath, defaultFs) || sourcePath;");
    expect(region, "the response must not choose the root").not.toMatch(
      /const sourceGitRoot\s*=\s*\n?\s*created\.sourceGitRoot/,
    );
    // And a claim that disagrees with the local answer is refused outright.
    expect(region).toContain("claims source");
    expect(region).toContain("claimedSourceGitRoot: claimedGitRoot");
  });

  it("does not start Grok just to create a worktree (AP-13a)", () => {
    // The temp-client lifetime this used to pin is gone: create uses a live
    // Grok client when one is already running in this checkout, and local git
    // otherwise. Starting a throwaway grok.exe just to `git worktree add` is
    // the lock AP-13a removes — and it is what made "Could not start Grok to
    // create a worktree" the only answer on a Claude-only install.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("Creating git worktree");
    expect(start).toBeGreaterThan(-1);
    const region = src.slice(start, src.indexOf("private watchWorktreeCreate", start));
    expect(region).toContain("liveGrokWorktreeClient");
    expect(region).toContain("createWorktreeViaLocalGit");
    expect(region).not.toContain("clientForWorktreeCreate");
    expect(region).not.toContain("Could not start Grok to create a worktree.");
    // The RPC path still exists for a live Grok session (clone mode).
    expect(region).toContain("using Grok RPC (clone mode available)");
    expect(region).toContain("using local git (linked worktree; clone mode is Grok-only)");
  });

  it("refuses a path that already existed before the create", () => {
    // "A worktree of this repo" is not "the worktree I just asked you to make".
    // Every SIBLING passes the first test, so a response naming one would take
    // over a checkout somebody else is working in — and Apply and Remove would
    // then act on it.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("using Grok RPC (clone mode available)");
    expect(start).toBeGreaterThan(-1);
    const region = src.slice(start, src.indexOf("this.worktreeCache.push", start));
    const snapshot = region.indexOf("const preExisting = await this.listAuthoritativeWorktreePaths");
    const create = region.indexOf("await client.createWorktree");
    expect(snapshot, "the snapshot must be taken BEFORE creating").toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(snapshot);
    expect(region).toContain("preExisting.some((p) => pathsEqual(p, wtPath))");
  });

  it("correlates the completion event to the worktree it asked for", () => {
    // Creation reuses whatever live client the project already has, so two
    // creates on one client interleave their notifications. Taking the first
    // terminal event let one create's completion release another's wait — and
    // that other flow would then start in a checkout still being copied.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private watchWorktreeCreate");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  private worktreeCreatesInFlight", start));
    // The decision itself is pure and tested above; what this pins is that the
    // watcher actually uses it, and feeds it the in-flight count that makes a
    // pathless progress event attributable.
    expect(body).toContain("worktreeStatusIsForCreate(e, {");
    expect(body).toContain("soleCreateInFlight: this.worktreeCreatesInFlight.sole(client),");
    // Events arriving before the RPC named the path must not be lost: a small
    // repo finishes before the call resolves.
    expect(body).toContain("// Replay what arrived before the path was known.");
  });

  it("waits on ONE long clock, never a short has-it-spoken-yet window", () => {
    // A short silence window was tried and was worse than the problem it
    // solved: a create-capable CLI whose first notification is slow, or whose
    // copy simply takes longer, got classified as a build that never reports
    // and admitted through the disk checks — which approve a half-copied
    // checkout, because registration lands before the files do. It widened the
    // unsafe window from "copies over two minutes" to "copies over five
    // seconds".
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const watch = src.slice(src.indexOf("private watchWorktreeCreate"));
    const body = watch.slice(0, watch.indexOf("\n  private worktreeCreatesInFlight"));
    expect(body).toContain('finish(capable() ? "stalled" : "silent")');
    expect(body, "no second, shorter clock").not.toContain("silenceMs");
    // IDLE, not elapsed. A fixed deadline calls a copy stopped for taking
    // long, which a big repository legitimately does — and the protocol emits
    // progress while copying, so quiet is the signal, not duration.
    expect(body).toContain("onActivity = arm;");
    expect(body).toMatch(/const arm = \(\) => \{\s*clearTimeout\(idle\);/);
    // ...but running OUT of it still means different things. A CLI that
    // reported progress and then stopped is an unfinished copy and must be
    // refused; one that never spoke predates the event and falls through to
    // the disk checks, exactly as every release before this did.
    const create = src.slice(src.indexOf("Creating git worktree"));
    const region = create.slice(0, create.indexOf("this.worktreeCache.push"));
    expect(region).toContain('if (outcome === "stalled")');
    expect(region).toContain("never finished being created");
    expect(region).toContain('if (outcome === "silent")');
    expect(region).not.toMatch(/if \(outcome === "silent"\)[\s\S]{0,200}showErrorMessage/);
  });

  it("holds a stalled create's slot so a retry cannot misread its events", () => {
    // A stalled create is one we STOPPED WAITING FOR, not one that ended — the
    // CLI may still be copying. Releasing the slot would let the next create
    // believe it is alone and trust pathless progress belonging to this one.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private watchWorktreeCreate");
    const body = src.slice(start, src.indexOf("\n  private worktreeCreatesInFlight", start));
    expect(body).toContain('detach({ keepSlot: outcome === "stalled" });');
    expect(body).toContain("releaseSlot({ keep: opts?.keepSlot });");
    // ...and it cannot outlive the process it describes. The listener that
    // guarantees that is registered when the slot is TAKEN, because `exit` is
    // one-shot: registering it at the moment a stall decides to hold the slot —
    // which is what this used to do — attaches to an event a CLI that crashed
    // mid-copy has already emitted.
    //
    // That ordering is a lifetime, and a lifetime is the one thing this kind of
    // source-text assertion cannot check. The real coverage is the
    // WorktreeCreateSlots suite in test/worktree.test.ts; all this pins is that
    // the watcher has not gone back to doing its own bookkeeping.
    expect(body).toContain("const releaseSlot = this.worktreeCreatesInFlight.take(client);");
    expect(body, "no hand-rolled listener or count in the watcher").not.toContain('"exit"');
    expect(body).not.toContain("worktreeCreatesInFlight.set(");
  });

  it("a retry after a stall fails closed, because we know this CLI reports", () => {
    // The interaction the retained slot creates: the retry cannot attribute
    // its own pathless progress (two creates are counted, by design), so it
    // would time out looking exactly like an old build — and fall through to
    // the disk checks. But the retained slot exists BECAUSE this client
    // reports, so "old build" is provably wrong there.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private watchWorktreeCreate");
    const body = src.slice(start, src.indexOf("\n  private worktreeCreatesInFlight", start));
    expect(body).toContain("this.worktreeStatusCapableClients.add(client);");
    expect(body).toContain("const capable = () => spoke || clientReportsStatus();");
    expect(body).toContain('finish(capable() ? "stalled" : "silent")');
  });

  it("refuses a second worktree create while one is running", () => {
    // The CLI's progress notifications carry no worktree path — only the
    // terminal one does — so two overlapping creates on one reused client
    // produce events that cannot be told apart. Serialising is the honest fix;
    // correlating uncorrelatable events is not.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("async newWorktreeSession");
    const body = src.slice(start, src.indexOf("private worktreeCreateInFlight", start));
    expect(body).toContain("if (this.worktreeCreateInFlight) {");
    expect(body).toContain("already being created");
    // Released on every exit, or the feature dies after its first failure.
    expect(body).toMatch(/finally \{\s*this\.worktreeCreateInFlight = false;/);
  });

  it("a failed CLI update still counts as this extension version's one attempt", () => {
    // REVERSED DELIBERATELY (owner's call, PR #129). This used to assert the
    // opposite — a failed update must not count — because the likeliest failure
    // is transient: on Windows another grok.exe holds the binary's lock, which
    // is the state a worktree create leaves for a moment, and recording the
    // version anyway suppressed every retry for the rest of the release.
    //
    // That reasoning only holds for a LOCK, which fails instantly and costs
    // nothing to retry. It is false for a network that cannot reach x.ai: there
    // a no-op `grok update` costs ~68s rather than ~0.8s (measured by funkpopo
    // in mainland China), this call is awaited before the spawn with the
    // composer locked, and leaving the marker unwritten re-charged that wait to
    // session startup on EVERY new window, forever. One user paying a
    // permanent multi-minute startup stall is worse than another missing one
    // optional update until the next release.
    //
    // Losing the lock retry is the accepted cost. It is self-correcting: the
    // update is optional, the version floor and Plan gating still run against
    // whatever is installed, and the CLI's own autoUpdate catches it up.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private async maybeUpdateCliOnUpgrade");
    const body = src.slice(start, src.indexOf("\n  }", src.indexOf("finally", start)));
    expect(body).not.toContain("updateFailed");
    expect(body).toContain("void this.state.update(CLI_UPDATE_VERSION_KEY, current);");
    // Unconditional: no flag, no branch guarding the write.
    expect(body.slice(body.indexOf("} finally {"))).not.toMatch(/if\s*\(/);
    // And the wait it can cost is bounded to something a person will sit through.
    expect(body).toContain("{ timeout: 20_000 }");
  });

  it("persists the worktree onto the session it created, not whatever is focused", () => {
    // `startSession` awaits, and focus is free to move while it runs. Reading
    // `this.focused` back afterwards wrote this worktree's name, path and
    // source root onto some other conversation — and a cold restore later
    // treats that saved binding as authoritative.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const create = src.slice(src.indexOf("Creating git worktree"));
    const region = create.slice(0, create.indexOf("Worktree session ready"));
    expect(region).toContain("await this.startSession(undefined, wtSession);");
    expect(region).toContain("const id = wtSession.activeSessionId;");
    expect(region, "the identifier must not be re-read from focus after the await").not.toMatch(
      /const id = this\.focused\.activeSessionId/,
    );
  });

  it("does not demand a clone marker from a worktree git already listed", () => {
    // Linked worktrees have no marker BY DESIGN. Running the check on them
    // logged "no clone provenance" for perfectly valid checkouts — which is
    // exactly the alarming line the owner reported for a worktree that worked.
    const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
    const start = src.indexOf("private async listAuthoritativeWorktreePaths");
    const body = src.slice(start, src.indexOf("\n  private ", start + 40));
    expect(body).toContain("if (authorized.some((p) => pathsEqual(p, row.path))) continue;");
  });
});
