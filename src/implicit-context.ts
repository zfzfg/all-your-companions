/**
 * ImplicitContext: active editor context watching, implicit/explicit chips,
 * and @ mention file indexing.
 *
 * Extracted from GrokSidebar as part of W-15 (Step S7g).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  Uri,
  disposeAll,
  type Host,
  type HostDisposable,
  type HostTerminalCapture,
} from "./host";
import type { Session } from "./session";
import type { MementoLike } from "./usage-host";
import {
  isDiagnosticsChip,
  isFileChip,
  isTerminalChip,
  makeDiagnosticsChip,
  makeTerminalChip,
  contextChipLabel,
  type ContextChip,
  type ContextChipPayload,
} from "./context-chips";
import {
  clearImplicitChips,
  isImplicitChip,
  makeExplicitChip,
  makeImplicitChip,
  selectionLineRange,
  implicitChipStartsHidden,
} from "./chips";
import {
  buildExcludeGlob,
  clampMentionIndexLimit,
  mergeMentionEntries,
  normalizeRelPath,
  orderMentionIndex,
  MENTION_INDEX_LIMIT,
  MENTION_INDEX_TTL_MS,
  type ContextSourceId,
} from "./mention";
import { pathsEqual } from "./worktree";
import { normalizeRepoPath, relativePathWithin } from "./sessions";
import { IMPLICIT_CHIP_HIDDEN_KEY } from "./sidebar-inbound";

export type AttachmentOwner = () => Session | undefined;

export interface ImplicitContextDeps {
  host: Host;
  state: MementoLike;
  sessionCwd(session: Session): string;
  workspaceRoot(): string;
  getFocused(): Session;
  getChips(): ContextChip[];
  setChips(chips: ContextChip[]): void;
  postChips(session?: Session): void;
  post(msg: any): void;
  notifyUser(level: "info" | "warning" | "error", text: string): void;
  revealAndFocusComposer(): void;
  trackAttach(p: Promise<void>): void;
  pickFileFromComputer(): Promise<void>;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
}

export class ImplicitContext {
  public mentionIndex: { at: number; rels: string[]; absByRel: Map<string, string> } | null = null;
  public mentionIndexPromise: Promise<{ rels: string[]; absByRel: Map<string, string> }> | null = null;
  public readonly otherCwdMentionIndexes = new Map<string, {
    at: number;
    rels: string[];
    absByRel: Map<string, string>;
  }>();
  public editorWatcher?: HostDisposable;

  constructor(private readonly deps: ImplicitContextDeps) {}

  public dispose(): void {
    this.editorWatcher?.dispose();
    this.editorWatcher = undefined;
  }

  public watchActiveEditor(): void {
    this.editorWatcher?.dispose();
    this.editorWatcher = disposeAll(
      this.deps.host.onDidChangeActiveTextEditor(() => this.refreshImplicitChip()),
      this.deps.host.onDidChangeActiveTextEditorSelection(() => this.refreshImplicitChip()),
    );
  }

  public implicitChipHidden(): boolean {
    return this.deps.state.get<boolean>(IMPLICIT_CHIP_HIDDEN_KEY, false);
  }

  public conversationRelPath(absPath: string): string | undefined {
    const root = this.deps.sessionCwd(this.deps.getFocused());
    const lexical = relativePathWithin(root, absPath);
    if (lexical === undefined) return undefined;
    try {
      if (relativePathWithin(fs.realpathSync(root), fs.realpathSync(absPath)) === undefined) {
        return undefined;
      }
    } catch {
      return undefined;
    }
    return lexical;
  }

  public refreshImplicitChip(forcePost = false): void {
    const includeActive = this.deps.host.getConfiguration("grok")
      .get<boolean>("includeActiveFileByDefault", true);
    const chips = this.deps.getChips();
    const prev = chips.filter(isFileChip).find(isImplicitChip);
    const editor = this.deps.host.getActiveTextEditor();

    if (!includeActive || !editor || editor.document.uri.scheme !== "file") {
      this.deps.setChips(clearImplicitChips(chips));
      if (prev || forcePost) this.deps.postChips();
      return;
    }

    const absPath = editor.document.uri.fsPath;
    const relPath = this.conversationRelPath(absPath);
    if (relPath === undefined) {
      this.deps.setChips(clearImplicitChips(chips));
      if (prev || forcePost) this.deps.postChips();
      return;
    }
    let selStart: number | undefined;
    let selEnd: number | undefined;
    if (!editor.selection.isEmpty) {
      const range = selectionLineRange(editor.selection.start, editor.selection.end);
      selStart = range.startLine;
      selEnd = range.endLine;
    }

    if (
      prev &&
      prev.path === absPath &&
      prev.relPath === relPath &&
      prev.selectionStart === selStart &&
      prev.selectionEnd === selEnd
    ) {
      if (forcePost) this.deps.postChips();
      return;
    }

    const next = makeImplicitChip(absPath, relPath, selStart, selEnd);
    next.hidden = implicitChipStartsHidden(prev, this.implicitChipHidden());
    const cleared = clearImplicitChips(chips);
    cleared.push(next);
    this.deps.setChips(cleared);
    this.deps.postChips();
  }

  public insertActiveMention(opts?: { selection?: boolean; uri?: Uri; pickIfMissing?: boolean }): void {
    const editor = this.deps.host.getActiveTextEditor();
    const pathUri = opts?.uri ?? editor?.document.uri;
    const absPath = pathUri?.fsPath;
    if (!absPath || !pathUri) {
      if (opts?.pickIfMissing) {
        void this.deps.trackAttach(this.deps.pickFileFromComputer());
      } else {
        void this.deps.host.showInformationMessage(
          "Grok: open a file in the editor first, then run this command.",
        );
      }
      return;
    }
    const sessionRoot = this.deps.sessionCwd(this.deps.getFocused());
    const relPath = this.conversationRelPath(absPath);
    if (relPath === undefined) {
      void this.deps.host.showWarningMessage(
        `That file is outside ${path.basename(sessionRoot) || "this project"}, which is where ` +
          "this conversation is running. Open a conversation in its project first.",
      );
      return;
    }
    let selStart: number | undefined;
    let selEnd: number | undefined;
    if (opts?.selection && editor && !editor.selection.isEmpty) {
      const range = selectionLineRange(editor.selection.start, editor.selection.end);
      selStart = range.startLine;
      selEnd = range.endLine;
    }
    const chips = this.deps.getChips();
    chips.push(makeExplicitChip(absPath, relPath, selStart, selEnd));
    this.deps.setChips(chips);
    this.deps.postChips();
    this.deps.revealAndFocusComposer();
  }

  public addContextSourceChip(
    source: ContextSourceId,
    owner: AttachmentOwner,
  ): void {
    const session = owner();
    if (!session) return;
    let chip: ContextChip;
    if (source === "problems") {
      let count: number;
      try {
        count = this.deps.host.getDiagnostics({ scope: "workspace" }).length;
      } catch (e) {
        this.deps.host.appendLine(`[context-chip] diagnostics probe failed: ${(e as Error).message}`);
        this.deps.notifyUser("warning", "Could not read the editor's problems.");
        return;
      }
      if (!count) {
        this.deps.notifyUser("info", "No problems reported — nothing to attach.");
        return;
      }
      chip = makeDiagnosticsChip({ scope: "workspace", count });
    } else {
      let capture: HostTerminalCapture | undefined;
      try {
        capture = this.deps.host.getTerminalCapture();
      } catch (e) {
        this.deps.host.appendLine(`[context-chip] terminal probe failed: ${(e as Error).message}`);
        this.deps.notifyUser("warning", "Could not read the terminal.");
        return;
      }
      if (!capture?.text.trim()) {
        this.deps.notifyUser(
          "info",
          "No terminal output captured yet. Run a command in the integrated terminal first — capture needs shell integration.",
        );
        return;
      }
      chip = makeTerminalChip({
        label: capture.label,
        bytes: Buffer.byteLength(capture.text, "utf8"),
      });
    }
    session.chips.push(chip);
    this.deps.postChips(session);
  }

  public contextChipPayloads(
    chips: readonly ContextChip[],
  ): (chip: ContextChip) => ContextChipPayload | undefined {
    const payloads = new Map<string, ContextChipPayload>();
    for (const chip of chips) {
      if (chip.hidden || isFileChip(chip)) continue;
      try {
        if (isDiagnosticsChip(chip)) {
          const items = this.deps.host.getDiagnostics({ scope: chip.scope, path: chip.path });
          payloads.set(chip.id, { kind: "diagnostics", items });
        } else if (isTerminalChip(chip)) {
          const capture = this.deps.host.getTerminalCapture();
          if (capture) payloads.set(chip.id, { kind: "terminal", label: capture.label, text: capture.text });
        }
      } catch (e) {
        this.deps.host.appendLine(
          `[context-chip] ${contextChipLabel(chip)} could not be collected: ${(e as Error).message}`,
        );
      }
    }
    return (chip) => payloads.get(chip.id);
  }

  public async mentionFileIndex(): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    const base = await this.mentionFindFilesIndex();
    const merged = mergeMentionEntries(base.absByRel, this.openWorkspaceFileEntries());
    if (merged === base.absByRel) return base;
    return { rels: orderMentionIndex([...merged.keys()]), absByRel: merged };
  }

  public async mentionFindFilesIndex(): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    const cached = this.mentionIndex;
    if (cached && Date.now() - cached.at < MENTION_INDEX_TTL_MS) return cached;
    if (!this.mentionIndexPromise) {
      this.mentionIndexPromise = this.buildMentionIndex()
        .then((idx) => {
          this.mentionIndex = { at: Date.now(), ...idx };
          return idx;
        })
        .finally(() => { this.mentionIndexPromise = null; });
    }
    return this.mentionIndexPromise;
  }

  private async buildMentionIndex(): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    const cfg = this.deps.host.getConfiguration();
    const exclude = buildExcludeGlob([
      cfg.get<Record<string, unknown>>("files.exclude"),
      cfg.get<Record<string, unknown>>("search.exclude"),
    ]);
    const limit = clampMentionIndexLimit(
      this.deps.host.getConfiguration("grok").get<number>("mentionIndexLimit", MENTION_INDEX_LIMIT),
    );
    const uris = await this.deps.host.findFiles("**/*", exclude, limit);
    const absByRel = new Map<string, string>();
    for (const uri of uris) {
      const rel = normalizeRelPath(this.deps.host.asRelativePath(uri));
      const abs = uri.fsPath;
      if (!absByRel.has(rel)) absByRel.set(rel, abs);
    }
    return { rels: orderMentionIndex([...absByRel.keys()]), absByRel };
  }

  public openWorkspaceFileEntries(): Array<{ rel: string; abs: string }> {
    return this.deps.host.openWorkspaceTextFiles().map((e) => ({
      rel: normalizeRelPath(e.rel),
      abs: e.abs,
    }));
  }

  public async mentionFileIndexForCwd(cwd: string): Promise<{ rels: string[]; absByRel: Map<string, string> }> {
    if (pathsEqual(cwd, this.deps.workspaceRoot())) return this.mentionFileIndex();
    const key = normalizeRepoPath(cwd);
    const cached = this.otherCwdMentionIndexes.get(key);
    if (cached && Date.now() - cached.at < MENTION_INDEX_TTL_MS) return cached;
    const cfg = this.deps.host.getConfiguration();
    const exclude = buildExcludeGlob([
      cfg.get<Record<string, unknown>>("files.exclude"),
      cfg.get<Record<string, unknown>>("search.exclude"),
    ]);
    const limit = clampMentionIndexLimit(
      this.deps.host.getConfiguration("grok").get<number>("mentionIndexLimit", MENTION_INDEX_LIMIT),
    );
    const uris = await this.deps.host.findFiles({ base: cwd, pattern: "**/*" }, exclude, limit);
    const absByRel = new Map<string, string>();
    for (const uri of uris) {
      const abs = uri.fsPath;
      const rel = normalizeRelPath(path.relative(cwd, abs));
      if (rel && !absByRel.has(rel)) absByRel.set(rel, abs);
    }
    const value = { at: Date.now(), rels: orderMentionIndex([...absByRel.keys()]), absByRel };
    this.otherCwdMentionIndexes.set(key, value);
    return value;
  }
}

export function createImplicitContext(deps: ImplicitContextDeps): ImplicitContext {
  return new ImplicitContext(deps);
}
