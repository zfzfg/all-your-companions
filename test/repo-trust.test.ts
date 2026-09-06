/**
 * What an untrusted REPOSITORY can do to you.
 *
 * The desktop app changes who opens the code: on one developer's machine every
 * repository is one they chose, and the interesting attacks need a hostile
 * renderer. Distributed to strangers, the repository itself becomes untrusted
 * input — and a repository is allowed to carry files that change how the agent
 * behaves before you have read a line of it.
 *
 * These are the three fixes that shipped for that, from the release-scoped
 * review on 2026-08-07.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { alwaysApproveSource, configForcesAlwaysApprove } from "../src/grok-config";
import { sessionScopedRoots } from "../src/auth-roots";

// Platform-injected fs stubs so both path worlds are testable from either OS —
// the whole reason the bug below survived is that nothing exercised POSIX.
const stubFs = (sep: "/" | "\\") => ({
  realpathSync: (p: string) => p,
  existsSync: () => true,
  statSync: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }) as never,
  lstatSync: () => ({ isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false }) as never,
  readdirSync: () => [] as never,
  sep,
});
const posixFs = stubFs("/") as never;
const win32Fs = stubFs("\\") as never;

const sidebarSrc = () =>
  fs.readFileSync(path.join(__dirname, "..", "src", "sidebar.ts"), "utf8");

const ALWAYS = '[ui]\npermission_mode = "always-approve"\n';
const ASK = '[ui]\npermission_mode = "ask"\n';

describe("who turned auto-approve on", () => {
  it("names the project when the project file forces it", () => {
    // The dangerous case: this file ships inside a repository, so cloning
    // someone's code is enough to carry it.
    expect(alwaysApproveSource({ project: ALWAYS })).toBe("project");
  });

  it("names the project even when the user's own setting disagrees", () => {
    // Project overrides global in grok, so a repo can override a deliberate
    // "ask me" with "never ask". That is the whole reason consent exists.
    expect(alwaysApproveSource({ project: ALWAYS, global: ASK })).toBe("project");
  });

  it("names global when it is the user's own standing choice", () => {
    // Not dangerous, and must stay silent — the user set this themselves in
    // their own TUI. Prompting here would train them to click through.
    expect(alwaysApproveSource({ global: ALWAYS })).toBe("global");
  });

  it("does not fall back to global when the project explicitly says otherwise", () => {
    // Precedence, not an OR: a project saying "ask" wins over a global
    // "always-approve", so there is nothing to consent to.
    expect(alwaysApproveSource({ project: ASK, global: ALWAYS })).toBeUndefined();
  });

  it("is undefined when nothing forces it", () => {
    expect(alwaysApproveSource({})).toBeUndefined();
    expect(alwaysApproveSource({ project: "[ui]\n", global: "" })).toBeUndefined();
  });

  it("still answers the old boolean question identically", () => {
    // configForcesAlwaysApprove is the mode indicator's input and must not have
    // changed meaning — the UI would start lying about "Auto accept".
    for (const input of [
      { project: ALWAYS },
      { project: ALWAYS, global: ASK },
      { global: ALWAYS },
      { project: ASK, global: ALWAYS },
      {},
    ]) {
      expect(configForcesAlwaysApprove(input)).toBe(alwaysApproveSource(input) !== undefined);
    }
  });
});

describe("consent gate wiring", () => {
  it("asks before the session starts, and declining starts nothing", () => {
    const src = sidebarSrc();
    const start = src.indexOf("private async startSessionBody(");
    expect(start).toBeGreaterThan(0);
    // Wide enough to reach ++session.gen past startSession's early-return
    // blocks as they grow; the assertions below still pin the ordering, the
    // slice only bounds the search.
    // Search bound only (see below) — and one that has to clear `++session.gen`
    // at ~6400 chars, which 6000 stopped doing when the open clock grew the
    // prologue. Too small a bound does not weaken this test, it BREAKS it: the
    // mutation reads as absent and the ordering assertion has nothing to compare.
    const body = src.slice(start, start + 9000);
    const asked = body.indexOf("confirmRepoForcedAutoApprove");
    expect(asked).toBeGreaterThan(0);
    // Before ++session.gen — nothing is mutated yet, so declining is a clean
    // no-op rather than a half-started session left behind.
    const mutates = body.indexOf("++session.gen");
    expect(mutates).toBeGreaterThan(0);
    expect(asked).toBeLessThan(mutates);
  });

  it("only prompts for a project-supplied config", () => {
    const src = sidebarSrc();
    const start = src.indexOf("private async confirmRepoForcedAutoApprove(");
    const body = src.slice(start, src.indexOf("private configForcesAutoApprove", start));
    expect(body).toContain('!== "project"');
    // Asked once per root, not once per session start — a project with several
    // conversations would otherwise prompt on every one of them.
    expect(body).toContain("autoApproveConsented");
  });
});

describe("desktop file roots are session-scoped", () => {
  const A = path.resolve("/work/repo-a");
  const B = path.resolve("/work/repo-b");
  // Both repos are open. That is the whole point: openness is not the question.
  const bothOpen = (cwd: string) => [A, B].some((r) => path.resolve(cwd) === r);

  it("a session in repo A cannot reach repo B, even though B is open", () => {
    const roots = sessionScopedRoots({ sessionCwd: A, isAuthorized: bothOpen, platform: "linux" });
    expect(roots).toEqual([A]);
    expect(roots).not.toContain(B);
  });

  it("carries the session's own worktree, which is not separately open", () => {
    const wt = path.resolve("/work/repo-a/.worktrees/feature");
    const roots = sessionScopedRoots({
      sessionCwd: A,
      worktreePath: wt,
      worktreeSourceRoot: A,
      isAuthorized: bothOpen,
      platform: "linux",
    });
    expect(roots).toContain(wt);
    expect(roots).toContain(A);
    expect(roots).not.toContain(B);
    // Deduped — A arrives twice, as cwd and as the worktree's source.
    expect(roots.filter((r) => r === A)).toHaveLength(1);
  });

  it("refuses a session cwd the host does not have open", () => {
    // A historical catalog cwd, or a folder that has since been closed.
    const closed = path.resolve("/work/closed");
    expect(sessionScopedRoots({ sessionCwd: closed, isAuthorized: bothOpen, platform: "linux" })).toEqual([]);
  });

  it("falls back to the active folder only when the session has no cwd", () => {
    expect(sessionScopedRoots({ activeRoot: A, isAuthorized: bothOpen, platform: "linux" })).toEqual([A]);
    // ...and the fallback is gated too.
    expect(
      sessionScopedRoots({ activeRoot: path.resolve("/nope"), isAuthorized: bothOpen, platform: "linux" }),
    ).toEqual([]);
  });

  it("dedupes case-insensitively on Windows and not elsewhere", () => {
    const win = sessionScopedRoots({
      sessionCwd: "C:/Work/Repo",
      worktreePath: "c:/work/repo",
      isAuthorized: () => true,
      platform: "win32",
    });
    expect(win).toHaveLength(1);
    const nix = sessionScopedRoots({
      sessionCwd: "/work/Repo",
      worktreePath: "/work/repo",
      isAuthorized: () => true,
      platform: "linux",
    });
    expect(nix).toHaveLength(2);
  });

  it("uses the asking session's cwd, not every open folder", () => {
    const src = sidebarSrc();
    const start = src.indexOf("desktopAuthRoots(session");
    const body = src.slice(start, src.indexOf("async addProjectFolder", start));
    expect(body).toContain("this.sessionCwd(session)");
    // The old shape: iterate the whole trusted set and return all of it. That
    // let a message from repo A reach a file in repo B.
    expect(body).not.toContain("for (const c of this.localTrustedSessionCwds");
    // Being open is still necessary — just no longer sufficient.
    expect(body).toContain("isAuthorizedCwd");
  });
});

describe("host confirmation on the messages that run something", () => {
  it("guards both execute-class handlers", () => {
    const src = sidebarSrc();
    for (const handler of ['case "runInstallCmd"', 'case "updateGrok"']) {
      const start = src.indexOf(handler);
      expect(start).toBeGreaterThan(0);
      const body = src.slice(start, start + 700);
      expect(body).toContain("confirmHostExecute");
    }
  });

  it("uses a host dialog the renderer cannot draw or dismiss", () => {
    const src = sidebarSrc();
    const start = src.indexOf("private async confirmHostExecute(");
    const body = src.slice(start, start + 700);
    // An in-webview confirm would be worthless here: the thing we are guarding
    // against is code running in the webview.
    expect(body).toContain("showWarningMessage");
    expect(body).toContain("modal: true");
  });
});

