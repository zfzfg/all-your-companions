import type { ContextChip } from "./context-chips";
/** ReviewHost: GrokSidebar collaborators. Methods moved unchanged. */
import type { Host } from "./host";
import { Uri } from "./host";
import * as fs from "node:fs";
import * as path from "node:path";
import { ExitPlanRequest } from "./acp";
import { parsePlanEntries } from "./plan-entries";
import { completedBlocksForPath, dropReviewPath, ingestReviewToolCall, normalizeReviewPath, planDiscardAll, planFileRevert, reviewCenterSnapshot } from "./review-center";
import type { ReviewScope } from "./review-center";
import { extractPermissionFacts, normalizePermissionKind } from "./permission-rules";
import { providerDisplayName } from "./provider-ui";
import { CHECKPOINT_MAX_FILE_BYTES, checkpointId, checkpointRelPath, mergeCheckpoints, planRestoreDetailed, previewUserMessage, restoreActions, sha256Bytes, snapshotFromBytes, survivingAfterClientRewind } from "./checkpoints";
import type { Checkpoint } from "./checkpoints";
import { CheckpointStore } from "./checkpoint-store";
import { Session, SessionStatus } from "./session";
import { captureGitTurnBaseline, readGitTurnFileBefore } from "./git-run";
import type { GitTurnBaseline } from "./git-run";
import { MAX_DIFF_EXPAND_BYTES, expandDiffToWholeFile, planEditRevert } from "./diff-view";
import { HostMsg } from "./protocol";

// Scheme for the permission-card diff preview's virtual documents. A read-only
// content provider (rather than an untitled buffer) means the diff tab never
// goes dirty, so closing it doesn't prompt to save. The path keeps the real
// filename so VS Code infers the language.
export const GROK_DIFF_SCHEME = "grok-diff";
import { pathsEqual } from "./worktree";



export interface ReviewHostDeps {
  diffSeq: number;
  readonly diffProvider: any;
  readonly openDiffsByRequest: any;
  readonly host: Host;
  sessionCwd(session: Session): string;
  emit(session: Session, message: HostMsg): void;
  readonly checkpointStore: CheckpointStore;
  confirmInChat(session: Session, opts: { title: string; body?: string; confirmLabel: string; danger?: boolean }): Promise<boolean>;
  createPlanReviewSnapshot(plan: string, sessionId?: string): Promise<{ path: string; name: string }>;
  syncHumanWait(session: Session): void;
  setStatus(session: Session, status: SessionStatus): void;
  readonly turnGitBaselines: any;
  readonly gitRunGate: any;
  notifyUser(level: "info" | "warning" | "error", text: string): void;
  truncateSessionCardsAfterRewind(sessionId: string, surviving: number): Promise<void>;
  applyRewindToView(session: Session, surviving: number): void;
  restoreComposerFor(session: Session, text: string, chips?: ContextChip[]): void;
}

export class ReviewHost {
  constructor(private readonly deps: ReviewHostDeps) {}

  private get diffSeq() { return this.deps.diffSeq; }
  private set diffSeq(value) { this.deps.diffSeq = value; }

  private get diffProvider() { return this.deps.diffProvider; }

  private get openDiffsByRequest() { return this.deps.openDiffsByRequest; }

  private get host() { return this.deps.host; }

  private get sessionCwd() { return this.deps.sessionCwd; }

  private get emit() { return this.deps.emit; }

  private get checkpointStore() { return this.deps.checkpointStore; }

  private get confirmInChat() { return this.deps.confirmInChat; }

  private get createPlanReviewSnapshot() { return this.deps.createPlanReviewSnapshot; }

  private get syncHumanWait() { return this.deps.syncHumanWait; }

  private get setStatus() { return this.deps.setStatus; }

  private get turnGitBaselines() { return this.deps.turnGitBaselines; }

  private get gitRunGate() { return this.deps.gitRunGate; }

  private get notifyUser() { return this.deps.notifyUser; }

  private get truncateSessionCardsAfterRewind() { return this.deps.truncateSessionCardsAfterRewind; }

  private get applyRewindToView() { return this.deps.applyRewindToView; }

  private get restoreComposerFor() { return this.deps.restoreComposerFor; }


  async openDiffEditor(
    session: Session,
    filePath: string,
    oldText: string,
    newText: string,
    requestId?: number | string,
    replaceAll?: boolean,
    sites?: { oldText: string; newText: string; oldLine?: number; newLine?: number }[],
  ): Promise<void> {
    const base = path.basename(filePath);
    // grok's diff block carries only the replaced region, which opens as a
    // context-free two-line tab. Expand it against the file on disk so the tab
    // shows the whole file and lands on the change (#66); a pending permission
    // hasn't been written yet, so there the file on disk is the "before".
    const sides = expandDiffToWholeFile({
      diskText: this.readFileForDiff(session, filePath),
      oldRegion: oldText,
      newRegion: newText,
      diskIsBefore: requestId !== undefined,
      replaceAll,
      sites,
    });
    // Unique key per diff so sequential edits to the same file don't collide on
    // the content map. The trailing real filename gives VS Code the language.
    const key = String(this.diffSeq++);
    const left = Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/before/${base}` });
    const right = Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/after/${base}` });
    this.diffProvider.set(left, sides.oldText);
    this.diffProvider.set(right, sides.newText);
    if (requestId !== undefined) {
      // Auto-open is per pending permission; remember the URIs so the matching
      // tab can be closed (and its content dropped) once the user decides (#21).
      const stale = this.openDiffsByRequest.set(session, requestId, { left, right });
      if (stale) this.closeDiffUris(stale);
    }
    // preview:false — VS Code keeps ONE preview slot per group, so a preview
    // diff evicted the file the user had single-clicked open (#167, upstream
    // 033360c; pinned by test/proposed-diff-preview.test.ts).
    // preserveFocus:true keeps focus on the chat so the permission card is
    // immediately clickable. `selection` opens a whole-file diff on the edit
    // instead of at line 1 (#66) — harmless at 0 when expansion fell back.
    const at = sides.firstChangedLine;
    await this.host.openDiff(left, right, `${providerDisplayName(session.provider)} proposed: ${base}`, {
      preview: false,
      preserveFocus: true,
      selection: {
        start: { line: at, character: 0 },
        end: { line: at, character: 0 },
      },
    });
  }

  /**
   * The file's current content, for whole-file diff expansion (#66). Undefined
   * when it can't be read — a create whose file doesn't exist yet, a file
   * deleted since, or one too big to hold twice — which leaves the diff at the
   * region-only fallback rather than failing the open.
   */
  /** Resolve a diff/revert file path against the session's cwd, revalidating
   *  containment on desktop (same TOCTOU class as openFsPath / file-tree
   *  open) immediately before use. Returns undefined when desktop's policy
   *  check refuses the path. VS Code keeps the plain resolve. */
  resolveDiffFilePath(session: Session, filePath: string): string | undefined {
    return path.isAbsolute(filePath) ? filePath : path.join(this.sessionCwd(session), filePath);
  }

  readFileForDiff(session: Session, filePath: string): string | undefined {
    try {
      const abs = this.resolveDiffFilePath(session, filePath);
      if (!abs) return undefined;
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_DIFF_EXPAND_BYTES) return undefined;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * Revert one completed edit (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md § 5). The
   * webview sends the diff block it already rendered rather than an id into
   * a host-side store; {@link planEditRevert} (pure — see diff-view.ts) turns
   * that plus the file's current disk content into a plan, and this method
   * only carries out the effects (read, confirm, write/delete) the plan asks
   * for.
   */
  async revertToolEdit(
    session: Session,
    msg: {
      toolCallId: string;
      path: string;
      oldText: string;
      newText: string;
      replaceAll?: boolean;
      sites?: { oldText: string; newText: string; oldLine?: number; newLine?: number }[];
    },
  ): Promise<void> {
    const respond = (ok: boolean, reason?: string) => {
      this.emit(session, {
        type: "toolEditReverted",
        toolCallId: msg.toolCallId,
        path: msg.path,
        ok,
        ...(reason ? { reason } : {}),
      });
    };
    const abs = this.resolveDiffFilePath(session, msg.path);
    if (!abs) {
      respond(false, "File could not be located.");
      return;
    }
    let currentText: string | undefined;
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= MAX_DIFF_EXPAND_BYTES) currentText = fs.readFileSync(abs, "utf8");
    } catch {
      currentText = undefined;
    }

    const plan = planEditRevert({
      oldText: msg.oldText,
      newText: msg.newText,
      replaceAll: msg.replaceAll,
      sites: msg.sites,
      currentText,
    });
    switch (plan.action) {
      case "unreadable":
        respond(false, "File could not be read.");
        return;
      case "conflict":
        respond(false, "The file has changed since this edit and can't be safely reverted.");
        return;
      case "delete-confirm":
      case "delete":
        if (plan.action === "delete-confirm") {
          const choice = await this.host.showWarningMessage(
            `${path.basename(abs)} has changed since this edit. Delete it anyway?`,
            "Delete",
            "Cancel",
          );
          if (choice !== "Delete") {
            respond(false, "Cancelled.");
            return;
          }
        }
        try {
          await this.host.fs.delete(Uri.file(abs), { useTrash: true });
          this.forgetReviewPath(session, msg.path, { toolCallId: msg.toolCallId });
          respond(true);
        } catch {
          respond(false, "Could not delete the file.");
        }
        return;
      case "write":
        try {
          await this.host.fs.writeFile(Uri.file(abs), Buffer.from(plan.text, "utf8"));
          this.forgetReviewPath(session, msg.path, { toolCallId: msg.toolCallId });
          respond(true);
        } catch {
          respond(false, "Could not write the file.");
        }
        return;
    }
  }

  /**
   * Fold a tool call's diff blocks into the review-center list (AP-09).
   *
   * Ingest always (including replay, so the snapshot after historyReplay has
   * the rows). Emit only live — replay would paint the panel N times before
   * `sessionUiSnapshot` sends the finished list.
   */
  noteReviewToolCall(session: Session, call: unknown): void {
    const turnId = String(session.userMessageCount || 0);
    const next = ingestReviewToolCall(session.reviewBlocks, call, turnId);
    if (next === session.reviewBlocks) return;
    if (next.length === session.reviewBlocks.length
      && next.every((b, i) => b === session.reviewBlocks[i])) return;
    const had = session.reviewBlocks.length > 0;
    session.reviewBlocks = next;
    if (!had && !next.length) return;
    if (!session.replaying) this.emitReviewCenter(session);
  }

  emitReviewCenter(session: Session): void {
    const currentTurnId = String(session.userMessageCount);
    this.emit(session, {
      type: "reviewCenter",
      currentTurnId,
      files: reviewCenterSnapshot(session.reviewBlocks, currentTurnId),
    });
  }

  forgetReviewPath(
    session: Session,
    filePath: string,
    opts?: { turnId?: string; toolCallId?: string },
  ): void {
    const next = dropReviewPath(session.reviewBlocks, filePath, opts);
    if (next.length === session.reviewBlocks.length) return;
    session.reviewBlocks = next;
    this.emitReviewCenter(session);
  }

  ackReviewReverted(session: Session, blocks: { toolCallId: string; path: string }[]): void {
    const seen = new Set<string>();
    for (const b of blocks) {
      const key = `${b.toolCallId}|${b.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.emit(session, {
        type: "toolEditReverted",
        toolCallId: b.toolCallId,
        path: b.path,
        ok: true,
      });
    }
  }

  /**
   * Discard one file's completed edits in the selected scope. Chains
   * `planEditRevert` in memory ({@link planFileRevert}) and performs one
   * write/delete — never N disk reverts that could stop mid-list.
   */
  async reviewRevertFile(session: Session, filePath: string, scope: ReviewScope): Promise<void> {
    const currentTurnId = String(session.userMessageCount);
    const blocks = completedBlocksForPath(session.reviewBlocks, filePath, scope, currentTurnId);
    const fail = (reason: string) => {
      const first = blocks[0];
      if (first) {
        this.emit(session, {
          type: "toolEditReverted",
          toolCallId: first.toolCallId,
          path: first.path,
          ok: false,
          reason,
        });
      }
    };
    if (!blocks.length) {
      fail("Nothing to discard for this file.");
      return;
    }
    const pathForDisk = blocks[blocks.length - 1].path;
    const abs = this.resolveDiffFilePath(session, pathForDisk);
    if (!abs) {
      fail("File could not be located.");
      return;
    }
    let currentText: string | undefined;
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile() && stat.size <= MAX_DIFF_EXPAND_BYTES) currentText = fs.readFileSync(abs, "utf8");
    } catch {
      currentText = undefined;
    }
    const plan = planFileRevert(blocks, currentText);
    switch (plan.action) {
      case "unreadable":
        fail("File could not be read.");
        return;
      case "conflict":
        fail("The file has changed since this edit and can't be safely reverted.");
        return;
      case "delete-confirm":
      case "delete":
        if (plan.action === "delete-confirm") {
          const choice = await this.host.showWarningMessage(
            `${path.basename(abs)} has changed since this edit. Delete it anyway?`,
            "Delete",
            "Cancel",
          );
          if (choice !== "Delete") {
            fail("Cancelled.");
            return;
          }
        }
        try {
          await this.host.fs.delete(Uri.file(abs), { useTrash: true });
        } catch {
          fail("Could not delete the file.");
          return;
        }
        break;
      case "write":
        try {
          await this.host.fs.writeFile(Uri.file(abs), Buffer.from(plan.text, "utf8"));
        } catch {
          fail("Could not write the file.");
          return;
        }
        break;
    }
    session.reviewBlocks = dropReviewPath(
      session.reviewBlocks,
      pathForDisk,
      scope === "turn" ? { turnId: currentTurnId } : undefined,
    );
    this.emitReviewCenter(session);
    this.ackReviewReverted(session, blocks);
  }

  /**
   * Discard every file in the selected scope by restoring the AP-08
   * checkpoint. Not N `planEditRevert`s — a conflict would otherwise leave
   * earlier files reverted and later ones untouched.
   */
  async reviewRevertAll(
    session: Session,
    scope: ReviewScope,
  ): Promise<void> {
    const currentTurnId = String(session.userMessageCount);
    const plan = planDiscardAll(scope, currentTurnId);
    if (plan.kind === "unavailable") {
      this.emit(session, { type: "hostNotice", level: "warning", text: "Can't discard all — there is no checkpoint for this turn." });
      return;
    }
    const sid = session.activeSessionId ?? session.client?.sessionId;
    if (!sid || !this.checkpointStore) {
      this.emit(session, { type: "hostNotice", level: "warning", text: "Can't discard all — there is no checkpoint for this turn." });
      return;
    }

    let merged: Checkpoint;
    if (plan.mode === "turn") {
      const cp = this.checkpointStore.load(sid, plan.turnId);
      if (!cp || cp.disabled || (!cp.files.length && !cp.skipped.length)) {
        this.emit(session, {
          type: "hostNotice",
          level: "warning",
          text: cp?.disabled
            ? `Can't discard all — the checkpoint for this turn is unavailable (${cp.disableReason || "disabled"}).`
            : "Can't discard all — there is no checkpoint for this turn.",
        });
        return;
      }
      merged = cp;
    } else {
      const later = this.checkpointStore.loadFrom(sid, 0);
      if (!later.length) {
        this.emit(session, { type: "hostNotice", level: "warning", text: "Can't discard all — there is no checkpoint for this conversation." });
        return;
      }
      merged = mergeCheckpoints(later);
    }

    const cwd = this.sessionCwd(session);
    const current = new Map<string, string | null>();
    for (const file of merged.files) {
      const abs = path.join(cwd, file.relPath);
      try {
        current.set(file.relPath, fs.readFileSync(abs, "utf8"));
      } catch {
        current.set(file.relPath, null);
      }
    }
    const restore = planRestoreDetailed(merged, current);
    const skippedNote = restore.skipped.length
      ? `\n\nNot restorable:\n${restore.skipped.map((s) => `• ${s.relPath} (${s.reason === "too-large" ? "too large" : "binary"}, ${s.bytes} bytes)`).join("\n")}`
      : "";
    const wouldTouch = restore.writes.length + restore.deletes.length + restore.conflicts.length;
    if (wouldTouch === 0 && !restore.skipped.length) {
      this.emit(session, { type: "hostNotice", level: "info", text: "Nothing to discard — files already match the checkpoint." });
      return;
    }
    if (wouldTouch > 0) {
      const ok = await this.confirmInChat(session, {
        title: "Discard all changes?",
        body: `This will restore ${wouldTouch} file(s) to how they were before ${scope === "turn" ? "this turn" : "this conversation"}.${skippedNote}`,
        confirmLabel: "Discard all",
        danger: true,
      });
      if (!ok) return;
    }
    let overwrite = false;
    if (restore.conflicts.length) {
      const items = [
        { label: "Overwrite all conflicting files", description: `${restore.conflicts.length} file(s) changed since the snapshot`, action: "overwrite" as const },
        { label: "Cancel", action: "cancel" as const },
      ];
      const pick = await this.host.showQuickPick(items, {
        placeHolder: "Restore anyway? Foreign changes will be overwritten.",
        ignoreFocusOut: true,
      });
      if (!pick || pick.action === "cancel") return;
      overwrite = true;
    }

    const toAck = (scope === "turn"
      ? session.reviewBlocks.filter((b) => b.turnId === currentTurnId)
      : session.reviewBlocks.slice());
    const actions = restoreActions(restore, overwrite, merged);
    const restored: string[] = [];
    const failed: string[] = [];
    for (const w of actions.writes) {
      const abs = path.join(cwd, w.relPath);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(w.blob, "utf8"));
        restored.push(w.relPath);
      } catch (e) {
        failed.push(`${w.relPath}: ${(e as Error).message}`);
      }
    }
    for (const rel of actions.deletes) {
      const abs = path.join(cwd, rel);
      try {
        fs.unlinkSync(abs);
        restored.push(rel);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") failed.push(`${rel}: ${(e as Error).message}`);
      }
    }

    // I/O failed mid-list: keep the remaining review rows so the user can
    // retry. Success (even with skipped unrestorable files) drops the scope.
    if (failed.length) {
      this.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: `Discarded some files, but ${failed.length} could not be restored:\n${failed.join("\n")}`,
      });
      for (const rel of restored) {
        session.reviewBlocks = dropReviewPath(
          session.reviewBlocks,
          rel,
          scope === "turn" ? { turnId: currentTurnId } : undefined,
        );
      }
    } else {
      if (scope === "turn") {
        session.reviewBlocks = session.reviewBlocks.filter((b) => b.turnId !== currentTurnId);
      } else {
        session.reviewBlocks = [];
      }
      const skip = restore.skipped.length
        ? ` Not restorable: ${restore.skipped.map((s) => s.relPath).join(", ")}.`
        : "";
      this.emit(session, {
        type: "hostNotice",
        level: "info",
        text: restored.length
          ? `Discarded ${restored.length} file(s).${skip}`
          : `Discarded.${skip}`,
      });
    }
    this.emitReviewCenter(session);
    const restoredSet = new Set(restored.map((rel) => normalizeReviewPath(rel)));
    const ackBlocks = failed.length
      ? toAck.filter((b) => restoredSet.has(normalizeReviewPath(b.path)))
      : toAck;
    this.ackReviewReverted(session, ackBlocks);
  }

  /** Close the diff tab opened for a pending permission request and free its
   *  virtual content (issue #21). No-op if the user already closed it. */
  closeDiffForRequest(session: Session, requestId: number | string): void {
    const uris = this.openDiffsByRequest.take(session, requestId);
    if (!uris) return;
    this.closeDiffUris(uris);
  }

  closeDiffUris(uris: { left: Uri; right: Uri }): void {
    this.host.closeDiffTabs(uris.left, uris.right);
    this.diffProvider.delete(uris.left, uris.right);
  }

  /**
   * Take one ACP `plan` update into the session (AP-02).
   *
   * One notification, two unrelated shapes — see src/plan-entries.ts. The
   * plan-TEXT stash below is unchanged from before AP-02 and still runs for
   * every provider: on a structured update each of those reads is `undefined`
   * and `lastPlanText` lands on "" exactly as it always did, so nothing about
   * grok's or Antigravity's path can move. Only a real `entries` list adds
   * anything, and there is no heuristic that could manufacture one from prose.
   */
  applyPlanUpdate(session: Session, u: any): void {
    // Fallback stash. Current CLIs send exit_plan_mode with planContent
    // populated; postExitPlanRequest prefers req.plan over lastPlanText.
    session.lastPlanText =
      (typeof u?.plan === "string" ? u.plan : "") ||
      (typeof u?.planText === "string" ? u.planText : "") ||
      (typeof u?.content === "string" ? u.content : "") ||
      (typeof u?.content?.text === "string" ? u.content.text : "");
    this.host.appendLine(`[plan] event payload keys: ${Object.keys(u ?? {}).join(", ")}`);
    const entries = parsePlanEntries(u);
    if (!entries) return;
    session.planEntries = entries;
    this.emit(session, { type: "planEntries", entries });
  }

  /**
   * Retire the checklist and SAY so.
   *
   * Separate from writing the field because the message is transient: a client
   * that is never told keeps painting the list it last received, and no buffer
   * replay will correct it.
   */
  clearPlanEntries(session: Session): void {
    if (!session.planEntries.length) return;
    session.planEntries = [];
    this.emit(session, { type: "planEntries", entries: [] });
  }

  async postExitPlanRequest(req: ExitPlanRequest, session: Session, gen: number): Promise<void> {
    const plan = req.plan || session.lastPlanText;
    let snapshot: { path: string; name: string } | undefined;
    try {
      snapshot = await this.createPlanReviewSnapshot(
        plan,
        session.activeSessionId ?? session.client?.sessionId,
      );
    } catch (e) {
      this.host.appendLine(`[plan-review] ${(e as Error).message}`);
    }
    if (gen !== session.gen) return;
    // Host ownership begins only after the snapshot's generation check. Re-focus
    // can replay the card without consuming this pending request.
    session.pendingExitPlans.set(req.id, { planText: plan });
    this.syncHumanWait(session);
    session.lastPlanText = "";
    this.emit(session, {
      type: "exitPlanRequest",
      req: { ...req, plan, planPath: snapshot?.path, planName: snapshot?.name },
    });
    this.setStatus(session, "needs-you");
  }

  async withPlanReviewPaths<T extends { text: string }>(
    plans: T[],
    sessionId?: string,
  ): Promise<Array<T & { planPath?: string; planName?: string }>> {
    const out: Array<T & { planPath?: string; planName?: string }> = [];
    for (const plan of plans) {
      try {
        const snapshot = await this.createPlanReviewSnapshot(plan.text, sessionId);
        out.push({ ...plan, planPath: snapshot.path, planName: snapshot.name });
      } catch (e) {
        this.host.appendLine(`[plan-review] ${(e as Error).message}`);
        out.push(plan);
      }
    }
    return out;
  }

  /** Drop client checkpoints for a deleted session. Best-effort, like plan-reviews. */
  removeCheckpoints(sessionId: string): void {
    try {
      this.checkpointStore?.removeSession(sessionId);
    } catch {
      /* never fail a delete over leftover snapshots */
    }
  }

  startTurnGitBaseline(session: Session, turn: object): void {
    // Prototype-built test sidebars have no fields; a real one always does.
    if (session.replaying || !this.turnGitBaselines || !this.gitRunGate) return;
    const root = this.sessionCwd(session);
    if (!root) return;
    const entry = { turnId: String(session.userMessageCount), root, turn, pending: true } as {
      turnId: string; root: string; turn: object; pending: boolean; baseline?: GitTurnBaseline;
    };
    this.turnGitBaselines.set(session, entry);
    // Skip a busy repo rather than queue a snapshot of a later working tree.
    if (!this.gitRunGate.tryAcquire(root)) { entry.pending = false; return; }
    void captureGitTurnBaseline(root).then((captured) => {
      if (entry.pending && entry.turn === turn && this.turnGitBaselines.get(session) === entry) {
        entry.baseline = captured;
      }
    }).catch(() => {
      // Best effort: no baseline keeps the Review Center's tool-call diff.
    }).finally(() => {
      entry.pending = false;
      this.gitRunGate.release(root);
    });
  }

  /**
   * The Review Center's "Open diff" in turn scope: one editor tab covering
   * everything this turn did to the file, against the git baseline taken as
   * the turn began (upstream 033360c). False when there is no trustworthy
   * baseline, so the caller falls back to the tool-call diff.
   */
  async openTurnGitDiff(session: Session, relPath: string): Promise<boolean> {
    const entry = this.turnGitBaselines?.get(session);
    if (!entry?.baseline || entry.pending) return false;
    if (entry.turnId !== String(session.userMessageCount)) return false;
    if (!pathsEqual(entry.root, this.sessionCwd(session))) return false;
    const abs = path.isAbsolute(relPath) ? relPath : path.join(entry.root, relPath);
    const rel = path.relative(entry.root, abs).split(path.sep).join("/");
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    const before = await readGitTurnFileBefore(entry.root, rel, entry.baseline);
    if (!before.ok) return false;
    // A deleted file is an empty after-side; an unreadable one is not a deletion.
    const after = fs.existsSync(abs) ? this.readFileForDiff(session, abs) : "";
    if (after === undefined) return false;
    const base = path.basename(rel);
    const key = String(this.diffSeq++);
    const left = Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/before/${base}` });
    const right = Uri.from({ scheme: GROK_DIFF_SCHEME, path: `/${key}/after/${base}` });
    this.diffProvider.set(left, before.text);
    this.diffProvider.set(right, after);
    await this.host.openDiff(left, right, `Turn diff: ${base}`, { preview: false, preserveFocus: true });
    return true;
  }

  beginCheckpointTurn(session: Session, text: string): void {
    if (session.replaying) return;
    session.checkpointTurn = {
      turnId: String(session.userMessageCount),
      preview: previewUserMessage(text),
      disabled: false,
      files: [],
      skipped: [],
    };
  }

  ensureCheckpointTurn(session: Session): Session["checkpointTurn"] | undefined {
    if (session.replaying) return undefined;
    if (session.userMessageCount < 1) return undefined;
    if (!session.checkpointTurn || session.checkpointTurn.turnId !== String(session.userMessageCount)) {
      session.checkpointTurn = {
        turnId: String(session.userMessageCount),
        preview: session.checkpointTurn?.preview ?? "",
        disabled: false,
        files: [],
        skipped: [],
      };
    }
    return session.checkpointTurn;
  }

  /**
   * Snapshot workspace files BEFORE the agent is allowed to write them.
   * Failures disable this turn's checkpoint and never throw — the turn continues.
   */
  snapshotToolCallWrites(
    session: Session,
    toolCall: { kind?: string; rawInput?: unknown; content?: unknown } | undefined,
    cwd: string,
  ): void {
    if (normalizePermissionKind(toolCall?.kind) !== "edit") return;
    this.snapshotRelOrAbsPaths(session, extractPermissionFacts(toolCall).paths, cwd);
  }

  snapshotPendingEditToolCall(session: Session, call: { kind?: string; status?: string; rawInput?: unknown; content?: unknown }): void {
    const status = String(call.status || "").toLowerCase();
    if (status === "completed" || status === "failed") return;
    this.snapshotToolCallWrites(session, call, this.sessionCwd(session));
  }

  snapshotRelOrAbsPaths(session: Session, paths: readonly string[], cwd: string): void {
    const abs = paths.map((p) => path.isAbsolute(p) ? p : path.join(cwd, p));
    this.snapshotAbsPaths(session, abs);
  }

  snapshotAbsPaths(session: Session, absPaths: readonly string[]): void {
    try {
      if (!this.checkpointStore || session.replaying) return;
      const turn = this.ensureCheckpointTurn(session);
      if (!turn || turn.disabled) return;
      const cwd = this.sessionCwd(session);
      let changed = false;
      for (const abs of absPaths) {
        if (!abs) continue;
        const rel = checkpointRelPath(abs, cwd);
        if (!rel) continue;
        if (turn.files.some((f) => f.relPath === rel) || turn.skipped.some((s) => s.relPath === rel)) continue;
        let bytes: Uint8Array | null = null;
        let reportedBytes: number | undefined;
        try {
          const st = fs.statSync(abs);
          if (!st.isFile()) continue;
          reportedBytes = st.size;
          if (st.size > CHECKPOINT_MAX_FILE_BYTES) {
            const cap = snapshotFromBytes(rel, null, { reportedBytes: st.size });
            if (cap.kind === "skipped") turn.skipped.push(cap.skipped);
            changed = true;
            continue;
          }
          bytes = fs.readFileSync(abs);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "ENOENT") bytes = null;
          else {
            this.disableCheckpointTurn(session, `read ${rel}: ${(e as Error).message}`);
            return;
          }
        }
        const cap = snapshotFromBytes(rel, bytes, { reportedBytes });
        if (cap.kind === "skipped") turn.skipped.push(cap.skipped);
        else turn.files.push(cap.file);
        changed = true;
      }
      if (changed) this.persistCheckpointTurn(session);
    } catch (e) {
      this.disableCheckpointTurn(session, (e as Error).message);
    }
  }

  noteCheckpointAfterContent(session: Session, absPath: string, content: string): void {
    const turn = session.checkpointTurn;
    if (!turn || turn.disabled) return;
    const rel = checkpointRelPath(absPath, this.sessionCwd(session));
    if (!rel) return;
    const file = turn.files.find((f) => f.relPath === rel);
    if (file) file.afterSha256 = sha256Bytes(Buffer.from(content, "utf8"));
  }

  persistCheckpointTurn(session: Session): void {
    const store = this.checkpointStore;
    const turn = session.checkpointTurn;
    const sid = session.activeSessionId;
    if (!store || !turn || !sid || turn.disabled) return;
    if (!turn.files.length && !turn.skipped.length) return;
    const result = store.save({
      id: checkpointId(sid, turn.turnId),
      sessionId: sid,
      turnId: turn.turnId,
      createdAt: Date.now(),
      userMessagePreview: turn.preview,
      files: turn.files,
      skipped: turn.skipped,
      bytes: turn.files.reduce((n, f) => n + Buffer.byteLength(f.blob, "utf8"), 0),
    });
    if (!result.ok) this.disableCheckpointTurn(session, result.reason);
  }

  disableCheckpointTurn(session: Session, reason: string): void {
    try {
      const turn = session.checkpointTurn;
      if (turn) {
        turn.disabled = true;
        turn.disableReason = reason;
        turn.files = [];
      }
      const sid = session.activeSessionId;
      try {
        if (sid && turn) this.checkpointStore?.disable(sid, turn.turnId, reason);
      } catch {
        /* store failure must not skip the notice */
      }
      this.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: `Checkpoint for this turn is off: ${reason}. Rewind will not restore these files.`,
      });
    } catch {
      /* never abort the turn */
    }
  }

  finishCheckpointTurn(session: Session): void {
    try {
      const turn = session.checkpointTurn;
      if (!turn || turn.disabled) return;
      const cwd = this.sessionCwd(session);
      for (const file of turn.files) {
        if (file.afterSha256) continue;
        const abs = path.join(cwd, file.relPath);
        try {
          file.afterSha256 = sha256Bytes(fs.readFileSync(abs));
        } catch {
          /* leave unset — restore treats unknown after-hash as a conflict */
        }
      }
      this.persistCheckpointTurn(session);
    } catch (e) {
      this.disableCheckpointTurn(session, (e as Error).message);
    }
  }

  /**
   * Provider-neutral rewind: restore files from client snapshots, then truncate
   * the transcript. Grok's native path is preferred when it exists; this is
   * the path for Codex/Claude/Gemini and Grok's fallback.
   */
  async rewindFromClientCheckpoints(
    session: Session,
    opts: {
      userBubbleIndex?: number;
      bubbleText?: string;
      totalUserBubbles?: number;
      edit: boolean;
      chips?: ContextChip[];
    },
  ): Promise<void> {
    const sid = session.activeSessionId;
    if (!sid) {
      return void this.notifyUser("warning", "Start a session before rewinding it.");
    }
    if (typeof opts.totalUserBubbles === "number" && opts.totalUserBubbles !== session.userMessageCount) {
      return void this.notifyUser("warning",
        "Restore points no longer line up with this conversation, so rewinding could remove the wrong turn. Reload the window and try again.",
      );
    }

    let surviving: number;
    if (typeof opts.userBubbleIndex === "number") {
      if (opts.userBubbleIndex < 0 || opts.userBubbleIndex >= session.userMessageCount) {
        return void this.notifyUser("info",
          opts.edit
            ? "Can't edit this message — the checkpoint is unavailable."
            : "Can't rewind to this message — it's the latest turn, or the checkpoint is unavailable.",
        );
      }
      if (!opts.edit && opts.userBubbleIndex === session.userMessageCount - 1) {
        return void this.notifyUser("info",
          "Can't rewind to this message — it's the latest turn, or the checkpoint is unavailable.",
        );
      }
      surviving = survivingAfterClientRewind(opts.userBubbleIndex);
    } else {
      const users = session.buffer.filter((m) => m.type === "userMessage" && !m.steer);
      const selectable = opts.edit ? users : users.slice(0, Math.max(0, users.length - 1));
      if (selectable.length === 0) {
        return void this.host.showInformationMessage(
          users.length <= 1
            ? "Only one message so far — hover an earlier user message and click Rewind."
            : "No rewind points available.",
        );
      }
      const items = selectable.map((m, i) => {
        const text = m.type === "userMessage" ? m.text : "";
        return {
          label: `#${i + 1}  ${previewUserMessage(text || "", 60)}`,
          description: undefined as string | undefined,
          index: i,
        };
      }).reverse();
      const pick = await this.host.showQuickPick(items, {
        placeHolder: "Rewind past which message? (it and everything after it are discarded)",
        ignoreFocusOut: true,
      });
      if (!pick) return;
      surviving = survivingAfterClientRewind(pick.index);
    }

    const later = this.checkpointStore?.loadFrom(sid, surviving) ?? [];
    const merged: Checkpoint = later.length ? mergeCheckpoints(later) : {
      id: checkpointId(sid, String(surviving + 1)),
      sessionId: sid,
      turnId: String(surviving + 1),
      createdAt: 0,
      userMessagePreview: "",
      files: [],
      skipped: later.flatMap((c) => c.skipped),
      bytes: 0,
    };
    const cwd = this.sessionCwd(session);
    const current = new Map<string, string | null>();
    for (const file of merged.files) {
      const abs = path.join(cwd, file.relPath);
      try {
        current.set(file.relPath, fs.readFileSync(abs, "utf8"));
      } catch {
        current.set(file.relPath, null);
      }
    }
    const plan = planRestoreDetailed(merged, current);
    const skippedNote = plan.skipped.length
      ? `\n\nNot restorable:\n${plan.skipped.map((s) => `• ${s.relPath} (${s.reason === "too-large" ? "too large" : "binary"}, ${s.bytes} bytes)`).join("\n")}`
      : "";
    const wouldTouch = plan.writes.length + plan.deletes.length + plan.conflicts.length;
    if (wouldTouch > 0) {
      const ok = await this.confirmInChat(session, {
        title: opts.edit ? "Edit this message?" : "Rewind past this message?",
        body: `This will restore ${wouldTouch} file(s) on disk to how they were before that message.${skippedNote}`,
        confirmLabel: opts.edit ? "Edit" : "Rewind",
        danger: true,
      });
      if (!ok) return;
    }
    let overwrite = false;
    if (plan.conflicts.length) {
      const items = [
        { label: "Overwrite all conflicting files", description: `${plan.conflicts.length} file(s) changed since the snapshot`, action: "overwrite" as const },
        { label: "Cancel", action: "cancel" as const },
        ...plan.conflicts.map((f) => ({ label: f, description: "changed since snapshot", action: "overwrite" as const })),
      ];
      const pick = await this.host.showQuickPick(items, {
        placeHolder: "Restore anyway? Foreign changes will be overwritten.",
        ignoreFocusOut: true,
      });
      if (!pick || pick.action === "cancel") return;
      overwrite = true;
    }

    if (
      ["working", "needs-you"].includes(session.status) ||
      session.activeSessionId !== sid
    ) {
      return void this.notifyUser("warning",
        `${opts.edit ? "Edit" : "Rewind"} cancelled because the conversation changed or another turn started. Nothing was rewound. Try ${opts.edit ? "Edit" : "Rewind"} again when the conversation is idle.`,
      );
    }

    const actions = restoreActions(plan, overwrite, merged);
    const restored: string[] = [];
    const failed: string[] = [];
    for (const w of actions.writes) {
      const abs = path.join(cwd, w.relPath);
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(w.blob, "utf8"));
        restored.push(w.relPath);
      } catch (e) {
        failed.push(`${w.relPath}: ${(e as Error).message}`);
      }
    }
    for (const rel of actions.deletes) {
      const abs = path.join(cwd, rel);
      try {
        fs.unlinkSync(abs);
        restored.push(rel);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") failed.push(`${rel}: ${(e as Error).message}`);
      }
    }

    await this.truncateSessionCardsAfterRewind(sid, surviving);
    this.applyRewindToView(session, surviving);
    this.checkpointStore?.pruneAfter(sid, surviving);
    const restoredText = (opts.bubbleText ?? "").trim();
    if (restoredText) this.restoreComposerFor(session, restoredText, opts.chips);

    if (failed.length) {
      this.notifyUser("error", `Rewound the conversation, but some files could not be restored:\n${failed.join("\n")}`);
    } else if (restored.length || plan.skipped.length) {
      const skip = plan.skipped.length
        ? ` Not restorable: ${plan.skipped.map((s) => s.relPath).join(", ")}.`
        : "";
      this.notifyUser("info",
        restored.length
          ? `Rewound. Restored ${restored.length} file(s).${skip}`
          : `Rewound.${skip}`,
      );
    }
  }
}
