import { providerCapability } from "./provider-capabilities";
/** WorktreeHost: GrokSidebar collaborators. Methods moved unchanged. */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AcpClient } from "./acp";
import { isCanonicallyInsideRoot } from "./file-tree";
import { listGitWorktreePaths } from "./git-worktree-list";
import type { Host } from "./host";
import type { PersistedState } from "./persisted-state";
import { Session } from "./session";
import {
  defaultFs,
  relativePathWithin,
  resolveGrokHome,
  type RepoListEntry,
  type SessionMetaOverrides,
} from "./sessions";
import {
  CLONE_WORKTREE_SOURCE_MARKER,
  cloneWorktreeSourceMatches,
  filterWorktreesForSourceRepo,
  gitRootForPath,
  isGitRepo,
  mergeWorktreeRefresh,
  pathsEqual,
  sanitizeWorktreeLabel,
  WorktreeCreateSlots,
  type WorktreeCreateOutcome,
  worktreeDisplayName,
  worktreePathAuthorizedForRepo,
  type WorktreeRecord,
  worktreeStatusIsForCreate,
  worktreeStatusVerdict,
} from "./worktree";
import type { CrewApplyOutcome } from "./crew-apply";
import { LocalGitWorktrees, nodeGitRunner, nodeWorktreeFs } from "./worktree-local";

export const SESSION_META_KEY = "grok.sessionMeta";

export interface WorktreeHostDeps {
  readonly host: Host;
  focused: Session;
  readonly pool: Set<Session>;
  readonly state: PersistedState;
  readonly sessionCache: Map<string, any>;
  workspaceRoot(): string;
  sessionCwd(session: Session): string;
  historyCwdFor(): string;
  openWorkspaceFolders(): string[];
  resolveLocalRepoTarget(cwd: string): RepoListEntry | undefined;
  newLocalSession(): Session;
  parkFocused(): void;
  startSession(resumeId?: string, target?: Session): Promise<any>;
  postSessionsList(): void;
  removeSessionFromDisk(id: string | undefined, sessionCwd?: string): boolean;
  confirmInChat(
    session: Session,
    opts: { title: string; body?: string; confirmLabel: string; danger?: boolean },
  ): Promise<boolean>;
  detachClient(session: Session): AcpClient | undefined;
}

export class WorktreeHost {
  constructor(private readonly deps: WorktreeHostDeps) {}

  private get host() { return this.deps.host; }
  private get focused() { return this.deps.focused; }
  private set focused(s: Session) { this.deps.focused = s; }
  private get pool() { return this.deps.pool; }
  private get state() { return this.deps.state; }
  private get sessionCache() { return this.deps.sessionCache; }
  private workspaceRoot(): string { return this.deps.workspaceRoot(); }
  private sessionCwd(session: Session): string { return this.deps.sessionCwd(session); }
  private historyCwdFor(): string { return this.deps.historyCwdFor(); }
  private openWorkspaceFolders(): string[] { return this.deps.openWorkspaceFolders(); }
  private resolveLocalRepoTarget(cwd: string): RepoListEntry | undefined { return this.deps.resolveLocalRepoTarget(cwd); }
  private newLocalSession(): Session { return this.deps.newLocalSession(); }
  private parkFocused(): void { return this.deps.parkFocused(); }
  private async startSession(resumeId?: string, target?: Session): Promise<any> { return this.deps.startSession(resumeId, target); }
  private postSessionsList(): void { return this.deps.postSessionsList(); }
  private removeSessionFromDisk(id: string | undefined, sessionCwd?: string): boolean { return this.deps.removeSessionFromDisk(id, sessionCwd); }
  private async confirmInChat(session: Session, opts: { title: string; body?: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
    return this.deps.confirmInChat(session, opts);
  }
  private detachClient(session: Session): AcpClient | undefined { return this.deps.detachClient(session); }

  async newWorktreeSession(): Promise<void> {
    // No worktree-from-worktree — checkouts stay singular. The gear hides this
    // inside a worktree; guard the Command-Palette path too.
    if (this.focused.worktree) {
      return void this.host.showInformationMessage(
        "You're already in a worktree. Start a new worktree from a normal session — worktrees don't nest.",
      );
    }
    // The CONVERSATION's repository — not the open folder, and not the rail's
    // selection either.
    //
    // Not the open folder, because a project-B conversation can be on screen in
    // a window opened on A: that made an A worktree out of a B conversation, and
    // Apply Worktree would later merge it into A. Not the selection, because
    // selecting a project in the rail changes the history scope and leaves the
    // focused conversation exactly where it was — "Continue in a worktree" is an
    // id-less action about the conversation in front of you, so a selection made
    // since would have branched from a checkout you never mentioned.
    //
    // One rule for every caller: a worktree is cut from the conversation it
    // continues. The Command Palette lands here too, and `focused` is the
    // conversation open there as well.
    const sourcePath = this.sessionCwd(this.focused);
    if (!isGitRepo(sourcePath, fs)) {
      return void this.host.showWarningMessage(
        "Worktree sessions need a git repository. Open a folder that is a git checkout (or run git init).",
      );
    }
    // One at a time. Creation reuses whatever live client the project already
    // has, and the CLI's progress notifications carry no worktree path — only
    // the terminal one does — so two overlapping creates on one client produce
    // events that cannot be told apart. Serialising is the honest fix; trying
    // to correlate uncorrelatable events is not. Nothing legitimate wants two
    // at once: this is a deliberate action.
    if (this.worktreeCreateInFlight) {
      return void this.host.showWarningMessage(
        "A worktree is already being created. Wait for it to finish before starting another.",
      );
    }
    this.worktreeCreateInFlight = true;
    try {
      await this.createWorktreeSession(sourcePath);
    } finally {
      this.worktreeCreateInFlight = false;
    }
  }

  /** Guards {@link newWorktreeSession} against overlapping creates. */
  private worktreeCreateInFlight = false;

  /** The body of {@link newWorktreeSession}, run under its single-flight guard. */
  private async createWorktreeSession(sourcePath: string): Promise<void> {
    const rawLabel = await this.host.showInputBox({
      prompt: "Worktree label (optional)",
      placeHolder: "e.g. feat-auth — leave blank for an auto name",
      ignoreFocusOut: true,
    });
    if (rawLabel === undefined) return; // cancelled
    const label = sanitizeWorktreeLabel(rawLabel);

    await this.host.withProgress(
      { title: "Creating git worktree…", cancellable: false },
      async () => {
        try {
          // Grok RPC stays the path when a Grok session is already running for
          // this checkout — it is proven and it knows clone mode. We never
          // start Grok just to make a worktree (AP-13a): no live Grok client
          // means the local git path, which can only produce a linked worktree
          // and says so rather than pretending a clone happened (18.8).
          const live = this.liveGrokWorktreeClient(sourcePath);
          if (!live) {
            this.host.appendLine("[worktree] using local git (linked worktree; clone mode is Grok-only)");
            await this.createWorktreeViaLocalGit(sourcePath, label);
            return;
          }
          this.host.appendLine("[worktree] using Grok RPC (clone mode available)");
          const creator = { client: live, disposeAfter: false };
          const { client, disposeAfter } = creator;
          // Disposed after the LAST validation query, not here and not at the
          // end. Not here, because validation asks this same client for its
          // worktree list and killing it first made that call reject every time
          // — invisible for a linked worktree, which local git lists anyway,
          // and fatal for a clone-mode one, which only the ACP list mentions.
          // Not at the end either: a temporary `grok.exe` still running while
          // the new session starts holds the executable's file lock on Windows,
          // and the first session after an extension upgrade is when the silent
          // CLI updater runs — it would fail, and then record the version
          // anyway, so the update would be skipped for the whole release.
          let created;
          let creatorDisposed = false;
          const releaseCreator = async () => {
            if (creatorDisposed || !disposeAfter) return;
            creatorDisposed = true;
            const probeId = client.sessionId;
            await client.dispose();
            if (probeId) this.removeSessionFromDisk(probeId, sourcePath);
          };
          try {
            // The authoritative set BEFORE creating anything. Without it,
            // "is this path a worktree of this repo" is the only question the
            // validator can answer — and an existing SIBLING worktree passes
            // it. A response naming one would have been cached, opened,
            // persisted, and later applied or removed as though we had just made it.
            const preExisting = await this.listAuthoritativeWorktreePaths(
              client,
              sourcePath,
              gitRootForPath(sourcePath, defaultFs) || sourcePath,
            );
            // Watch BEFORE the RPC. `createWorktree` returns while the status
            // is still "creating" and completion rides an event, so a small
            // repo can finish before the call even resolves — a listener
            // attached afterwards waits for something that already happened.
            const watch = this.watchWorktreeCreate(client);
            try {
              created = await client.createWorktree({
                sourcePath,
                label: label || undefined,
              });
            } catch (createErr) {
              watch.cancel();
              throw createErr;
            }
            if (created === "unsupported") {
              watch.cancel();
              return void this.host.showWarningMessage(
                "Worktrees need a newer Grok Build CLI. Update via Settings → About.",
              );
            }
            const wtPath = created.worktreePath;
            const wtLabel = label || path.basename(wtPath);
            this.host.appendLine(`[worktree] created ${wtPath} (label=${wtLabel})`);

            // Wait for the CLI to say it is DONE, not merely for the checkout
            // to exist. Registration happens before the files are copied, so
            // `.git` on disk and a `git worktree list` entry both appear while
            // the copy is still running — and the temporary creator we are
            // about to dispose is the process doing the copying. Killing it
            // then leaves a partial checkout that every later check calls
            // valid, with staged or untracked work silently absent.
            //
            // Bounded, and a timeout falls through to the disk checks rather
            // than failing: an older CLI may not emit the event at all, and
            // refusing a good worktree over a missing notification would be a
            // worse trade than the race it protects against.
            const outcome = await watch.settled(wtPath);
            if (outcome === "failed") {
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" was not created: the Grok CLI reported it failed.`,
              );
            }
            if (outcome === "stalled") {
              // It reported progress and then stopped. That is an unfinished
              // copy, not an old CLI — and the checks below cannot tell the
              // difference, because registration lands before the files do.
              this.host.appendLine(`[worktree] create reported progress then stalled: ${wtPath}`);
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" never finished being created, so no session was started. The partial checkout was left at ${wtPath}.`,
              );
            }
            if (outcome === "silent") {
              // Nothing at all was said about this create, so the CLI predates
              // the status event. The checks below are how this worked before
              // it existed — an unchanged risk rather than a new one.
              this.host.appendLine(`[worktree] no status reported for ${wtPath}; using disk checks`);
            }
            // create is ASYNC — the RPC returns "creating" before git writes the
            // checkout (its dir + `.git` pointer appear a beat later). Spawning a
            // session in a not-yet-existing cwd hangs the whole flow, so wait for
            // the checkout to land before validating or starting the session.
            const ready = await this.waitForWorktreeReady(wtPath, 30000);
            if (!ready) {
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" was created but its checkout never appeared on disk — the session wasn't started. Try again, or check \`git worktree list\`.`,
              );
            }

            // Validate against an authoritative worktree list before cache /
            // overrides / auth roots. A compromised or malformed ACP path must
            // not become a trusted session cwd.
            //
            // The root we QUERY is derived locally from the folder the user
            // actually asked to branch — never from the response. Taking
            // `created.sourceGitRoot` first (as this did) made the check answer
            // itself: the same value arrived as both the claim and the thing the
            // claim was compared against, so it always matched. A response naming
            // repository B could then hand back a genuine worktree OF B, have git
            // truthfully list it, and be filed under A.
            const sourceGitRoot = gitRootForPath(sourcePath, defaultFs) || sourcePath;
            const claimedGitRoot = created.sourceGitRoot?.trim() || undefined;
            if (claimedGitRoot && !pathsEqual(claimedGitRoot, sourceGitRoot) && !pathsEqual(claimedGitRoot, sourcePath)) {
              this.host.appendLine(
                `[worktree] refused: create claims source ${claimedGitRoot}, but ${sourcePath} is in ${sourceGitRoot}`,
              );
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" came back attributed to a different repository, so no session was started.`,
              );
            }
            // Ask more than once. The create RPC returns as soon as git is asked,
            // and `waitForWorktreeReady` only proves the DIRECTORY exists — the
            // worktree can still be missing from `git worktree list` for a beat
            // after that. Validating on the first answer refused a perfectly good
            // checkout roughly 14ms after creating it: "not in git worktree list".
            //
            // This weakens nothing. The path must still appear in an authoritative
            // list; it is only given the moment it needs to get there.
            let listedPaths = await this.listAuthoritativeWorktreePaths(
              client,
              sourcePath,
              sourceGitRoot,
            );
            for (let attempt = 0; attempt < 6; attempt++) {
              if (listedPaths.some((p) => pathsEqual(p, wtPath))) break;
              await new Promise((r) => setTimeout(r, 250));
              listedPaths = await this.listAuthoritativeWorktreePaths(
                client,
                sourcePath,
                sourceGitRoot,
              );
            }
            if (
              !worktreePathAuthorizedForRepo({
                worktreePath: wtPath,
                sourceRepo: sourcePath,
                listedWorktreePaths: listedPaths,
                claimedSourceGitRoot: claimedGitRoot,
                sourceGitRoot,
              })
            ) {
              this.host.appendLine(
                `[worktree] refused unlisted/unauthorized path from create: ${wtPath}`,
              );
              // The CLI already wrote a checkout there — for a clone-mode repo, a
              // full copy of it. Refusing without saying so left the directory
              // behind silently, so the next attempt with the same label got a
              // "-2" suffix and the owner accumulated orphans they had no way to
              // see. We do not delete it: it is real work on disk and this path
              // is reached precisely when we could NOT establish what it is.
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" could not be confirmed as part of this repository, so no session was started. The checkout was left at ${wtPath} — remove it yourself if you don't want it.`,
              );
            }
            // "A worktree of this repo" is not the same claim as "the worktree
            // I just asked you to make". Every sibling passes the first test,
            // so a response naming one would take over a checkout somebody else
            // is working in — and Apply and Remove would then act on it.
            if (preExisting.some((p) => pathsEqual(p, wtPath))) {
              this.host.appendLine(
                `[worktree] refused: ${wtPath} already existed before this create`,
              );
              return void this.host.showErrorMessage(
                `Worktree "${wtLabel}" already existed before this request, so no session was started. Open it from the conversation list instead.`,
              );
            }

            // Every question that needed the creator has been asked. Let it go
            // BEFORE the session starts — see the note where it was obtained.
            await releaseCreator();

            // Refresh cache only after validation.
            this.worktreeCache = this.worktreeCache.filter((w) => !pathsEqual(w.path, wtPath));
            this.worktreeCache.push({
              id: wtLabel,
              path: wtPath,
              sourceRepo: sourcePath,
              repoName: path.basename(sourcePath),
              kind: "session",
              creationMode: "linked",
              gitRef: "HEAD",
              headCommit: "",
              status: "alive",
              label: wtLabel,
              userProvidedLabel: !!label,
            });

            // Open a brand-new session whose process cwd is the worktree.
            this.parkFocused();
            // Held as an OBJECT across the await, never re-read from
            // `this.focused`. Focus is free to move while startup runs — the
            // user can click another conversation — and reading it back
            // afterwards wrote this worktree's name, path and source root onto
            // whatever session happened to be focused by then. A cold restore
            // later treats that saved binding as authoritative, so the wrong
            // conversation comes back believing it lives in the worktree.
            const wtSession = this.newLocalSession();
            this.focused = wtSession;
            this.pool.add(wtSession);
            wtSession.cwd = wtPath;
            wtSession.worktree = {
              path: wtPath,
              label: wtLabel,
              sourceGitRoot,
            };
            await this.startSession(undefined, wtSession);
            const id = wtSession.activeSessionId;
            if (id) {
              const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
              await this.state.update(SESSION_META_KEY, {
                ...overrides,
                [id]: {
                  ...(overrides[id] ?? {}),
                  customName: worktreeDisplayName(wtLabel),
                  worktreePath: wtPath,
                  worktreeLabel: wtLabel,
                  sourceGitRoot,
                },
              });
              this.sessionCache.delete(id);
            }
              this.postSessionsList();
              void this.host.showInformationMessage(
                `Worktree session ready: ${wtLabel}. Edits stay isolated until you Apply worktree.`,
              );
          } finally {
            // Belt: every early return above lands here too.
            await releaseCreator();
          }
        } catch (e: any) {
          void this.host.showErrorMessage(`Create worktree failed: ${e?.message ?? e}`);
        }
      },
    );
  }

  /**
   * Watch one worktree create through to completion.
   *
   * Started BEFORE the RPC, because the CLI can finish a small repo before the
   * call resolves — so events are BUFFERED until the path is known and then
   * replayed. The path arrives from the RPC's own answer, which is why this is
   * two steps rather than one call.
   *
   * Correlation is the point. Creation reuses whatever live client the project
   * already has, so two creates on one client interleave their notifications;
   * accepting the first terminal event on the client let one create's
   * completion release another's wait, and that other flow would then start in
   * a checkout still being copied. An event with a `worktreePath` must name
   * OURS. An event without one is only trusted while a single create is in
   * flight on that client, which is the ordinary case and the one older CLIs
   * produce.
   *
   * The timeout distinguishes two situations that look identical from here:
   *
   *  - the CLI never said ANYTHING about this create → it does not speak the
   *    status protocol. Fall through to the disk and git checks, which is how
   *    this worked before the event existed.
   *  - the CLI DID report progress and then went quiet → it speaks the
   *    protocol and the copy is genuinely unfinished. Registration happens
   *    before the files are copied, so the disk checks would call a partial
   *    checkout valid. Refuse instead.
   */
  private watchWorktreeCreate(client: AcpClient, timeoutMs = 120000) {
    const events: Array<{ status?: string; worktreePath?: string }> = [];
    let target: string | undefined;
    let settleNow: ((o: WorktreeCreateOutcome) => void) | undefined;
    // Whether this CLI has said ANYTHING about our create. It is what separates
    // "does not speak the protocol" from "spoke, then stopped", and it is only
    // trustworthy because creates are serialised: progress notifications carry
    // no worktree path, so attributing one depends on there being exactly one
    // create it could belong to.
    let spoke = false;

    const mine = (e: { worktreePath?: string }) =>
      worktreeStatusIsForCreate(e, {
        target,
        soleCreateInFlight: this.worktreeCreatesInFlight.sole(client),
      });
    const verdict = worktreeStatusVerdict;
    // Arrow, so `this` is the sidebar: the object returned below has methods
    // of its own and would shadow it.
    const clientReportsStatus = () => this.worktreeStatusCapableClients.has(client);
    let onActivity: (() => void) | undefined;
    const onStatus = (status: { status?: string; worktreePath?: string }) => {
      // ANY event on this client — ours or not — proves the CLI emits status
      // notifications. That fact outlives a single create, and it is the thing
      // that makes "we heard nothing, so this must be an old build" a safe
      // inference or a false one.
      this.worktreeStatusCapableClients.add(client);
      events.push(status || {});
      if (!settleNow || !target) return; // buffered; replayed once we know ours
      if (!mine(status)) return;
      // Any matched event counts, progress included — that is the whole point
      // of the flag. Only a terminal one settles the wait.
      spoke = true;
      onActivity?.();
      const outcome = verdict(status);
      if (outcome) settleNow(outcome);
    };

    // Taking the slot also registers the listener that releases it when the CLI
    // dies — at watch START, which is the whole point. `exit` is one-shot, so
    // registering it later (as this used to, only once a stall decided to hold
    // the slot) attaches to an event a crashed CLI has already emitted.
    // See WorktreeCreateSlots for the two properties and why they are there.
    const releaseSlot = this.worktreeCreatesInFlight.take(client);
    try {
      client.on("worktreeStatus", onStatus);
    } catch {
      /* a client that cannot subscribe simply never reports */
    }

    const detach = (opts?: { keepSlot?: boolean }) => {
      try {
        client.off?.("worktreeStatus", onStatus);
      } catch {
        /* best effort — a disposed client has nothing to detach from */
      }
      releaseSlot({ keep: opts?.keepSlot });
    };

    return {
      /** Abandon the watch without waiting (the RPC failed or was unsupported). */
      cancel: () => detach(),
      /** Wait for OUR create to finish, now that the RPC has named its path. */
      settled(worktreePath: string): Promise<WorktreeCreateOutcome> {
        target = worktreePath;
        return new Promise<WorktreeCreateOutcome>((resolve) => {
          let done = false;
          const timers: Array<ReturnType<typeof setTimeout>> = [];
          const finish = (outcome: WorktreeCreateOutcome) => {
            if (done) return;
            done = true;
            for (const t of timers) clearTimeout(t);
            // A stalled create is one we STOPPED WAITING FOR, not one that
            // ended: the CLI may still be copying. Releasing its slot would let
            // the next create believe it is the only one in flight and trust
            // pathless progress events that belong to this one. The listener is
            // dropped either way; only the count is held, and only until the
            // client goes.
            detach({ keepSlot: outcome === "stalled" });
            resolve(outcome);
          };
          settleNow = finish;
          // ONE clock, and a long one.
          //
          // A short "has it said anything yet" window was tried and was worse
          // than the problem: a create-capable CLI whose first notification is
          // slow, or whose copy simply takes longer, was classified as a build
          // that never reports and admitted through the disk checks — which
          // approve a half-copied checkout, because registration lands before
          // the files do. That widened the unsafe window from "copies over two
          // minutes" to "copies over five seconds".
          //
          // What running out MEANS still depends on whether it ever spoke.
          // Deleting that distinction along with the short clock was the
          // over-correction: a CLI that reported progress and then stopped is
          // an unfinished copy, and letting it fall through hands the disk
          // checks the partial checkout they are guaranteed to approve.
          //
          // IDLE, not elapsed. A fixed deadline calls a copy stopped for taking
          // long, which for a big repository it legitimately does — and the
          // protocol emits progress while copying, so quiet is the signal, not
          // duration. Every matched event restarts the clock; only silence
          // running out ends the wait.
          //
          // "Silent" is a claim about the CLI, not about this create, so it is
          // only safe while nothing has ever proved otherwise. A retry after a
          // stall cannot attribute its own progress — the abandoned create's
          // slot is still held, so pathless events are ambiguous by design —
          // and reading that as "old build, fall through to the disk checks"
          // would be provably wrong: the retained slot exists BECAUSE this
          // client reports. Fail closed there.
          const capable = () => spoke || clientReportsStatus();
          let idle: ReturnType<typeof setTimeout>;
          const arm = () => {
            clearTimeout(idle);
            idle = setTimeout(() => finish(capable() ? "stalled" : "silent"), timeoutMs);
            timers.push(idle);
          };
          onActivity = arm;
          arm();
          // Replay what arrived before the path was known.
          for (const e of events) {
            if (!mine(e)) continue;
            spoke = true;
            const outcome = verdict(e);
            if (outcome) return finish(outcome);
          }
        });
      },
    };
  }

  /**
   * Live creates per client, so an event with no `worktreePath` can be trusted
   * only when there is exactly one create it could belong to. Lifetime rules
   * and their reasons live on {@link WorktreeCreateSlots}.
   */
  private worktreeCreatesInFlight = new WorktreeCreateSlots();

  /**
   * Clients observed emitting `worktree/status` at least once.
   *
   * Kept per client rather than per create because it is a fact about the
   * BUILD, and it is what stops "we heard nothing" from being read as "this
   * CLI is too old" in a case where we already know better.
   */
  private worktreeStatusCapableClients = new WeakSet<AcpClient>();

  /** Poll until a freshly-created worktree's checkout exists on disk (its `.git`
   *  pointer file, which `git worktree add` writes). create is async — the RPC
   *  returns "creating" before git finishes — so a session spawned in the cwd
   *  before this would hang. Accepts a bare dir over hanging if `.git` never
   *  shows. */
  private async waitForWorktreeReady(worktreePath: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (fs.existsSync(path.join(worktreePath, ".git"))) return true;
      } catch { /* keep polling */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    // The timeout fallback used to accept the bare directory. A directory with
    // no `.git` is not a checkout — it is what is left when creation failed
    // halfway — and calling it ready is how grok came to be spawned in an empty
    // folder and exit 1. If the loop above never saw a `.git`, there isn't one.
    return false;
  }

  /**
   * A live Grok ACP client whose cwd is `sourcePath`.
   *
   * The RPC path is only used when Grok is already running in this checkout —
   * clone mode lives there, and starting a throwaway Grok just to `git
   * worktree add` is the lock AP-13a removes. A Grok session in a different
   * cwd does not count: its create would be about a different repository.
   */
  private liveGrokWorktreeClient(sourcePath: string): AcpClient | undefined {
    const match = (s: Session) =>
      providerCapability(s.provider, "nativeWorktree").state === "yes" && !!s.client?.sessionId && pathsEqual(this.sessionCwd(s), sourcePath);
    for (const s of this.pool) {
      if (match(s) && s.client) return s.client;
    }
    if (match(this.focused) && this.focused.client) return this.focused.client;
    return undefined;
  }

  /** Lazy local-git worktree ops. Tests inject `this.localWorktrees`. */
  localWorktrees?: LocalGitWorktrees;

  worktreeLocal(): LocalGitWorktrees {
    return this.localWorktrees ?? (this.localWorktrees = new LocalGitWorktrees({
      git: nodeGitRunner(),
      fs: nodeWorktreeFs(),
      now: () => Date.now(),
      join: (...parts) => path.join(...parts),
      dirname: (p) => path.dirname(p),
      basename: (p) => path.basename(p),
      log: (msg) => this.host.appendLine(msg),
    }));
  }

  /**
   * Create a linked worktree with local git and open a session in it.
   * The choice is already logged by the caller; this is the body.
   */
  private async createWorktreeViaLocalGit(sourcePath: string, label: string): Promise<void> {
    const sourceGitRoot = gitRootForPath(sourcePath, defaultFs) || sourcePath;
    const root = path.join(resolveGrokHome(), "worktrees");
    const created = await this.worktreeLocal().create({
      sourcePath,
      label: label || undefined,
      root,
    });
    if ("error" in created) {
      return void this.host.showErrorMessage(`Create worktree failed: ${created.error}`);
    }
    const wtPath = created.worktreePath;
    const wtLabel = label || path.basename(wtPath);
    const ready = await this.waitForWorktreeReady(wtPath, 30000);
    if (!ready) {
      return void this.host.showErrorMessage(
        `Worktree "${wtLabel}" was created but its checkout never appeared on disk — the session wasn't started. Try again, or check \`git worktree list\`.`,
      );
    }
    const listed = await listGitWorktreePaths(sourceGitRoot, {
      log: (msg) => this.host.appendLine(msg),
    });
    if (
      !worktreePathAuthorizedForRepo({
        worktreePath: wtPath,
        sourceRepo: sourcePath,
        listedWorktreePaths: listed,
        claimedSourceGitRoot: created.sourceGitRoot,
        sourceGitRoot,
      })
    ) {
      this.host.appendLine(`[worktree] refused unlisted/unauthorized path from local create: ${wtPath}`);
      return void this.host.showErrorMessage(
        `Worktree "${wtLabel}" could not be confirmed as part of this repository, so no session was started. The checkout was left at ${wtPath} — remove it yourself if you don't want it.`,
      );
    }
    await this.bindCreatedWorktreeSession(wtPath, wtLabel, sourceGitRoot, !!label);
  }

  /** Cache + open a fresh session in a worktree that has already been validated. */
  private async bindCreatedWorktreeSession(
    wtPath: string,
    wtLabel: string,
    sourceGitRoot: string,
    userProvidedLabel: boolean,
  ): Promise<void> {
    this.worktreeCache = this.worktreeCache.filter((w) => !pathsEqual(w.path, wtPath));
    this.worktreeCache.push({
      id: wtLabel,
      path: wtPath,
      sourceRepo: sourceGitRoot,
      repoName: path.basename(sourceGitRoot),
      kind: "session",
      creationMode: "linked",
      gitRef: "HEAD",
      headCommit: "",
      status: "alive",
      label: wtLabel,
      userProvidedLabel,
    });
    this.parkFocused();
    const wtSession = this.newLocalSession();
    this.focused = wtSession;
    this.pool.add(wtSession);
    wtSession.cwd = wtPath;
    wtSession.worktree = {
      path: wtPath,
      label: wtLabel,
      sourceGitRoot,
    };
    await this.startSession(undefined, wtSession);
    const id = wtSession.activeSessionId;
    if (id) {
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      await this.state.update(SESSION_META_KEY, {
        ...overrides,
        [id]: {
          ...(overrides[id] ?? {}),
          customName: worktreeDisplayName(wtLabel),
          worktreePath: wtPath,
          worktreeLabel: wtLabel,
          sourceGitRoot,
        },
      });
      this.sessionCache.delete(id);
    }
    this.postSessionsList();
    void this.host.showInformationMessage(
      `Worktree session ready: ${wtLabel}. Edits stay isolated until you Apply worktree.`,
    );
  }

  /** Merge the given session's worktree back into the main checkout.
   *  `skipConfirm` = the webview's custom confirm dialog already ran. */
  async applyFocusedWorktree(session: Session = this.focused, skipConfirm = false): Promise<void> {
    const wt = session.worktree;
    if (!wt) {
      return void this.host.showInformationMessage(
        "This session is not in a worktree. Start one with Grok: New Worktree Session.",
      );
    }
    if (!skipConfirm) {
      const ok = await this.host.showWarningMessage(
        `Apply worktree "${wt.label}" into the main checkout?\n\n${wt.path}\n→ ${wt.sourceGitRoot || this.workspaceRoot()}`,
        { modal: true },
        "Apply",
      );
      if (ok !== "Apply") return;
    }
    const sourceGitRoot = wt.sourceGitRoot || this.workspaceRoot();
    const grokClient = providerCapability(session.provider, "nativeWorktree").state === "yes" ? session.client : undefined;
    if (grokClient?.sessionId) {
      this.host.appendLine("[worktree] using Grok RPC (clone mode available)");
      try {
        const r = await grokClient.applyWorktree(wt.path);
        if (r === "unsupported") {
          return void this.host.showWarningMessage(
            "Apply worktree needs a newer Grok Build CLI. Update via Settings → About.",
          );
        }
        const n = r.files?.length ?? 0;
        this.host.appendLine(`[worktree] apply ${wt.path}: ${n} file(s), status=${r.status}`);
        void this.host.showInformationMessage(
          n ? `Applied ${n} file${n === 1 ? "" : "s"} from worktree "${wt.label}".` : `Worktree "${wt.label}" applied (no file changes).`,
        );
      } catch (e: any) {
        void this.host.showErrorMessage(`Apply worktree failed: ${e?.message ?? e}`);
      }
      return;
    }
    this.host.appendLine("[worktree] using local git (linked worktree; clone mode is Grok-only)");
    await this.applyWorktreeViaLocalGit(session, wt.path, sourceGitRoot, wt.label);
  }

  /**
   * File-by-file apply through the same conflict rule as planEditRevert:
   * a source file that moved since the branch point is a card, never a write.
   */
  async applyWorktreeViaLocalGit(
    session: Session,
    worktreePath: string,
    sourceGitRoot: string,
    label: string,
  ): Promise<CrewApplyOutcome> {
    try {
      const first = await this.worktreeLocal().apply({ worktreePath, sourceGitRoot, textMerge: true });
      if ("conflicts" in first && first.conflicts.length) {
        const listed = first.conflicts.map((f) => `• ${f}`).join("\n");
        const ok = await this.confirmInChat(session, {
          title: "Files changed since this worktree branched",
          body: `These files in the main checkout changed after the worktree was created. Overwrite them?\n${listed}`,
          confirmLabel: "Overwrite",
          danger: true,
        });
        if (!ok) {
          this.host.appendLine(`[worktree] apply ${worktreePath}: refused ${first.conflicts.length} conflict(s), no write`);
          return { kind: "declined", files: first.conflicts };
        }
        const second = await this.worktreeLocal().apply({ worktreePath, sourceGitRoot, overwrite: true });
        if ("conflicts" in second && second.conflicts.length) {
          return { kind: "conflict", files: second.conflicts };
        }
        if ("error" in second) {
          void this.host.showErrorMessage(`Apply worktree failed: ${second.error}`);
          const appliedFiles = "appliedFiles" in second && Array.isArray(second.appliedFiles) ? second.appliedFiles : [];
          return { kind: "failed", message: second.error, appliedFiles };
        }
        const files = second.files.map((file) => file.path);
        const n = files.length;
        this.host.appendLine(`[worktree] apply ${worktreePath}: ${n} file(s), status=${second.status} (overwrite)`);
        void this.host.showInformationMessage(
          n ? `Applied ${n} file${n === 1 ? "" : "s"} from worktree "${label}".` : `Worktree "${label}" applied (no file changes).`,
        );
        return n ? { kind: "applied", files } : { kind: "unchanged", files: [] };
      }
      if ("error" in first) {
        void this.host.showErrorMessage(`Apply worktree failed: ${first.error}`);
        const appliedFiles = "appliedFiles" in first && Array.isArray(first.appliedFiles) ? first.appliedFiles : [];
        return { kind: "failed", message: first.error, appliedFiles };
      }
      const n = first.files?.length ?? 0;
      this.host.appendLine(`[worktree] apply ${worktreePath}: ${n} file(s), status=${first.status}`);
      void this.host.showInformationMessage(
        n ? `Applied ${n} file${n === 1 ? "" : "s"} from worktree "${label}".` : `Worktree "${label}" applied (no file changes).`,
      );
      return n ? { kind: "applied", files: first.files.map((file) => file.path) } : { kind: "unchanged", files: [] };
    } catch (e: any) {
      const message = e?.message ?? String(e);
      void this.host.showErrorMessage(`Apply worktree failed: ${message}`);
      return { kind: "failed", message, appliedFiles: [] };
    }
  }

  /** Remove the given session's worktree (after disposing processes that use it).
   *  `skipConfirm` = the webview's custom confirm dialog already ran. */
  async removeFocusedWorktree(session: Session = this.focused, skipConfirm = false): Promise<void> {
    const wt = session.worktree;
    if (!wt) {
      return void this.host.showInformationMessage("This session is not in a worktree.");
    }
    if (!skipConfirm) {
      const ok = await this.host.showWarningMessage(
        `Remove worktree "${wt.label}"?\n\n${wt.path}\n\nThis deletes the isolated checkout. Unapplied edits are lost.`,
        { modal: true },
        "Remove",
      );
      if (ok !== "Remove") return;
    }
    try {
      // Any live process still using the worktree as cwd locks remove on Windows.
      for (const s of [...this.pool]) {
        if (s.worktree && pathsEqual(s.worktree.path, wt.path)) {
          // Detach, don't hand-roll: this used to drop the client without ending
          // the turn, so a cancel recovery armed before the removal still held a
          // live token and a matching generation and would respawn the session
          // against a checkout that no longer exists.
          void this.detachClient(s)?.dispose();
          if (s !== session) this.pool.delete(s);
        }
      }
      // Grok RPC when this session is Grok and still has a client — clone-mode
      // checkouts only the CLI can name. Otherwise local `git worktree remove`
      // (AP-13a). We never start Grok just to delete a directory.
      const grokClient = providerCapability(session.provider, "nativeWorktree").state === "yes" ? session.client : undefined;
      if (!grokClient?.sessionId) {
        this.host.appendLine("[worktree] using local git (linked worktree; clone mode is Grok-only)");
        const local = await this.worktreeLocal().remove({ worktreePath: wt.path, force: true });
        if ("error" in local) {
          const refusal = this.canSelfRemoveWorktree(wt);
          if (refusal) {
            this.host.appendLine(`[worktree] self-remove refused: ${refusal}`);
            void this.host.showErrorMessage(
              `Remove worktree failed: ${local.error}. The checkout at ${wt.path} was left alone because ${refusal}.`,
            );
            return;
          }
          this.host.appendLine(`[worktree] local remove failed (${local.error}); removing the checkout directly`);
          fs.rmSync(wt.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        }
        await this.finishRemovedWorktree(session, wt, { removed: true });
        return;
      }
      this.host.appendLine("[worktree] using Grok RPC (clone mode available)");
      const client = grokClient;
      let r;
      try {
        try {
          r = await client.removeWorktree(wt.path);
        } catch (rpcErr: any) {
          // The CLI refuses ("Internal error") for a checkout git does not
          // recognise as a worktree — which is exactly the clone-mode case,
          // where `git worktree remove` has nothing to remove. That left the
          // user with a directory they explicitly asked to delete, an error
          // they could do nothing about, and a row still in the rail.
          //
          // We delete it ourselves, but only where we can prove all three:
          // it lives under the grok worktrees root, it carries the marker
          // naming this repo, and it is not the repo itself. Anything less
          // and the error stands.
          const detail = rpcErr?.message ?? String(rpcErr);
          const refusal = this.canSelfRemoveWorktree(wt);
          if (refusal) {
            this.host.appendLine(`[worktree] self-remove refused: ${refusal}`);
            void this.host.showErrorMessage(
              `Remove worktree failed: ${detail}. The checkout at ${wt.path} was left alone because ${refusal}.`,
            );
            return;
          }
          this.host.appendLine(
            `[worktree] CLI remove failed (${detail}); removing the checkout directly`,
          );
          fs.rmSync(wt.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          r = { removed: true };
        }
      } catch (e: any) {
        void this.host.showErrorMessage(`Remove worktree failed: ${e?.message ?? e}`);
        return;
      }
      if (r === "unsupported") {
        return void this.host.showWarningMessage(
          "Remove worktree needs a newer Grok Build CLI. Update via Settings → About.",
        );
      }
      await this.finishRemovedWorktree(session, wt, r);
    } catch (e: any) {
      void this.host.showErrorMessage(`Remove worktree failed: ${e?.message ?? e}`);
    }
  }

  /**
   * After a successful remove: drop the cache/meta, start a replacement
   * conversation in the project the worktree was cut from.
   */
  private async finishRemovedWorktree(
    session: Session,
    wt: { path: string; label: string; sourceGitRoot?: string },
    r: { removed: boolean },
  ): Promise<void> {
      // WHO OWNED IT — captured before the records that answer that are erased.
      // `resolveLocalRepoTarget` finds the owning project by walking session
      // ownership, and the next few lines drop the worktree from the cache and
      // strip its bindings from session meta, after which the lookup returns
      // nothing and the fallback lands on the git ROOT. For a nested project
      // (`/repo/packages/app` inside a `/repo` checkout) that is one level up,
      // free to touch sibling packages — and on desktop, where `/repo` is not an
      // open folder, startSession refuses it and the promised replacement
      // conversation never appears at all.
      const worktreeOwnerCwd = this.resolveLocalRepoTarget(wt.path)?.cwd;
      this.worktreeCache = this.worktreeCache.filter((w) => !pathsEqual(w.path, wt.path));
      this.host.appendLine(`[worktree] removed ${wt.path} (removed=${r.removed})`);
      // Clear worktree binding on meta for sessions that pointed here.
      const overrides = this.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      let changed = false;
      const next: SessionMetaOverrides = { ...overrides };
      for (const [id, o] of Object.entries(overrides)) {
        if (o.worktreePath && pathsEqual(o.worktreePath, wt.path)) {
          const { worktreePath: _p, worktreeLabel: _l, sourceGitRoot: _s, ...rest } = o;
          next[id] = rest;
          changed = true;
        }
      }
      if (changed) await this.state.update(SESSION_META_KEY, next);
      session.worktree = undefined;
      // Leave the chat; start a normal session so the user isn't stuck — in the
      // repository this worktree was cut FROM, which is where the work goes back
      // to. The open folder was right only while conversations were pinned to
      // it; the rail can put you in another project entirely, and landing in the
      // window's folder then dropped you somewhere you had not been working.
      this.parkFocused();
      this.focused = this.newLocalSession();
      this.pool.add(this.focused);
      // The catalog PROJECT that owned the worktree (captured above), not its
      // git root — that is the relationship the rail draws, and where the work
      // goes back to.
      this.focused.cwd = worktreeOwnerCwd || wt.sourceGitRoot || this.historyCwdFor();
      await this.startSession();
      this.postSessionsList();
      void this.host.showInformationMessage(`Removed worktree "${wt.label}".`);
  }

  /** Cached worktree list for the current repo (refreshed on create/list). */
  worktreeCache: WorktreeRecord[] = [];

  async refreshWorktreeCache(): Promise<void> {
    const session = this.focused.client
      ? this.focused
      : [...this.pool].find((candidate) => !!candidate.client);
    const client = session?.client;
    if (!client) return;
    const sourceRepo = session.worktree?.sourceGitRoot || this.sessionCwd(session);
    const sourceGitRoot = gitRootForPath(sourceRepo, defaultFs) ?? sourceRepo;
    try {
      const list = await client.listWorktrees({});
      if (list === "unsupported") return;
      // mergeWorktreeRefresh filters unattributed / wrong-repo rows.
      this.worktreeCache = mergeWorktreeRefresh(this.worktreeCache, sourceRepo, list, {
        sourceGitRoot,
      });
    } catch (e: any) {
      this.host.appendLine(`[worktree] list failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Authoritative worktree paths for `sourcePath`: prefer the CLI list RPC
   * (scoped to that client's repo), fall back to `git worktree list --porcelain`.
   */
  private async listAuthoritativeWorktreePaths(
    client: AcpClient,
    sourcePath: string,
    sourceGitRoot: string,
  ): Promise<string[]> {
    // git first, and ALWAYS — it is the only party here that cannot be wrong
    // about its own worktrees, and it is a local process that answers in
    // milliseconds. What used to happen: an ACP list with any attributed row
    // was returned as-is and git was consulted only when that list came back
    // empty. So a path the agent named, and nothing else could confirm, passed
    // a check whose whole job was to confirm it — which is how an EMPTY
    // DIRECTORY became a session cwd and grok exited 1 inside it.
    const gitPaths = await listGitWorktreePaths(sourceGitRoot || sourcePath, {
      log: (m) => this.host.appendLine(m),
    });
    const authorized = [...gitPaths];
    const add = (p: string) => {
      if (p && !authorized.some((existing) => pathsEqual(existing, p))) authorized.push(p);
    };
    try {
      const list = await client.listWorktrees({});
      if (list !== "unsupported" && Array.isArray(list)) {
        // ACP rows still need corroboration, but a CLONE-mode checkout has a
        // second kind of proof available: the marker the CLI writes inside it.
        // Those never appear in the source repo's `git worktree list` — they
        // are separate repositories — so before this they were refused outright
        // and the feature simply did not work for any repo the CLI clones.
        for (const row of filterWorktreesForSourceRepo(list, sourcePath, { sourceGitRoot })) {
          // git already vouched for it — asking for a clone marker as well would
          // fail every LINKED worktree and log an alarming line about a checkout
          // that is perfectly valid.
          if (authorized.some((p) => pathsEqual(p, row.path))) continue;
          if (this.cloneWorktreeBelongsTo(row.path, sourcePath, sourceGitRoot)) add(row.path);
        }
      }
    } catch (e: any) {
      this.host.appendLine(`[worktree] listWorktrees for validate failed: ${e?.message ?? e}`);
    }
    return authorized;
  }

  /**
   * Whether we may delete this checkout ourselves after the CLI refused to.
   *
   * A recursive delete is the most destructive thing in this file, so the fence
   * is deliberately narrow — the user's confirmation already said "this deletes
   * the isolated checkout", and this decides only whether the thing in front of
   * us IS an isolated checkout. Location is necessary but never sufficient; on
   * top of it we need ONE of two positive answers:
   *
   *  - **nothing to lose** — the directory is gone or empty. This is the common
   *    case in practice, and the one that kept the owner stuck: the CLI deletes
   *    the contents and THEN fails to deregister, so by the time it reports
   *    "Internal error" the checkout is already an empty folder with no marker,
   *    no `.git`, and nothing left to prove anything with. Refusing there is
   *    refusing to delete an empty directory the user asked us to delete.
   *  - **provenance** — the clone marker names the repo it claims to come from,
   *    for a checkout that still has contents worth being careful about.
   *
   * Returns the reason on refusal so the error the user sees can say it.
   */
  private canSelfRemoveWorktree(wt: { path: string; sourceGitRoot?: string }): string | undefined {
    const target = wt?.path;
    // The session's own binding carries only the git root; the cache has the
    // full record when we have one. Either way this is the repo the MARKER has
    // to name — get it wrong and the check fails closed, which is the point.
    const cached = this.worktreeCache.find((w) => pathsEqual(w.path, target));
    const source = cached?.sourceRepo || wt?.sourceGitRoot || this.workspaceRoot();
    if (!target || !path.isAbsolute(target)) return "no absolute path to remove";
    const root = path.join(resolveGrokHome(), "worktrees");
    if (!relativePathWithin(root, target)) return `it is outside ${root}`;
    if (pathsEqual(target, root)) return "it is the worktrees root itself";
    if (source && pathsEqual(target, source)) return "it is the source repository";
    for (const folder of this.openWorkspaceFolders()) {
      if (pathsEqual(target, folder)) return "it is an open folder";
    }
    let contents: string[] | undefined;
    try {
      contents = fs.readdirSync(target);
    } catch {
      // Already gone — the CLI removed it and then failed on the bookkeeping.
      return undefined;
    }
    if (!contents.length) return undefined;
    if (!source) return "the source repository is unknown";
    if (this.cloneWorktreeBelongsTo(target, source, gitRootForPath(source, defaultFs) || source)) {
      return undefined;
    }
    return `it has contents but no ${CLONE_WORKTREE_SOURCE_MARKER} naming ${source}`;
  }

  /**
   * Whether `worktreePath` carries an on-disk marker naming `sourceRepo`.
   *
   * The I/O wrapper around {@link cloneWorktreeSourceMatches} — kept here so the
   * decision itself stays pure and testable, and so every refusal says why in
   * the log rather than leaving the owner with "not in git worktree list" for a
   * checkout that was never going to be in one.
   */
  private cloneWorktreeBelongsTo(
    worktreePath: string,
    sourceRepo: string,
    sourceGitRoot: string,
  ): boolean {
    // LOCATION FIRST, and it is not optional. A marker is a file, and a file is
    // something whoever proposed the path can write — so on its own it proves
    // only that the proposer touched that directory, not that we made it. Grok
    // creates clone-mode worktrees under its own root and nowhere else, so
    // anything outside that root is not one of ours whatever it contains.
    // Canonical, because a symlink planted inside the root and pointing
    // somewhere else entirely would satisfy a textual prefix check.
    //
    // The DELETE path already demanded this. Authorization is the more
    // dangerous of the two: it ends with a Grok process running in that
    // directory, and the path persisted on the session.
    const root = path.join(resolveGrokHome(), "worktrees");
    if (!isCanonicallyInsideRoot(root, worktreePath)) {
      this.host.appendLine(
        `[worktree] refused clone provenance for ${worktreePath}: outside ${root}`,
      );
      return false;
    }
    const ok = cloneWorktreeSourceMatches({
      worktreePath,
      sourceRepo,
      sourceGitRoot,
      readMarker: (markerPath) => fs.readFileSync(markerPath, "utf8"),
      joinPath: (a, b) => path.join(a, ...b.split("/")),
    });
    if (!ok) {
      this.host.appendLine(
        `[worktree] no clone provenance for ${worktreePath} (expected ${CLONE_WORKTREE_SOURCE_MARKER} naming ${sourceRepo})`,
      );
    }
    return ok;
  }
}
