/**
 * Review-center aggregation (AP-09).
 *
 * Diffs in chat are per tool-call. This module folds them into a per-file
 * list with `+N −M`, path-deduped: a file edited three times is one row
 * whose counts compare the scope baseline with its latest observed result.
 *
 * Pure — no vscode, no fs, no clock. The host tracks the blocks; the webview
 * only renders the snapshot. "Discard file" runs {@link planFileRevert}
 * (chained {@link planEditRevert} in memory, one write). "Discard all" is
 * NOT N of those — it restores the AP-08 checkpoint, which is atomic
 * against conflicts.
 */

import { computeLineDiff } from "./shared/line-diff";
import { planEditRevert, type DiffSite, type EditRevertPlan } from "./diff-view";

export type ReviewScope = "turn" | "session";

export type ReviewBlockStatus = "pending" | "completed" | "failed";

export interface ReviewDiffSite {
  oldText: string;
  newText: string;
  oldLine?: number;
  newLine?: number;
}

export interface ReviewDiffBlock {
  path: string;
  nativePath?: string;
  oldText: string;
  newText: string;
  sites: ReviewDiffSite[];
  replaceAll?: boolean;
  toolCallId: string;
  turnId: string;
  status: ReviewBlockStatus;
  reviewRoot?: string;
  reviewBefore?: { text: string; existed: boolean; source: "git" | "checkpoint" | "native" };
  reviewSessionBefore?: ReviewDiffBlock["reviewBefore"];
  reviewAfter?: { text: string; existed: boolean };
  oldTextMissing?: boolean;
  fileOperation?: "add" | "delete" | "update";
}

export interface ReviewFileDiffPayload {
  toolCallId: string;
  net?: boolean;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  sites: ReviewDiffSite[];
}

export interface ReviewCenterFileView {
  path: string;
  countsKnown?: boolean;
  turnCountsKnown?: boolean;
  netAvailable?: boolean;
  turnNetAvailable?: boolean;
  baselineSource?: string;
  added: number;
  removed: number;
  turnAdded: number;
  turnRemoved: number;
  completed: boolean;
  turnCompleted: boolean;
  /** Last block in the session — native `openDiff` payload. */
  diff: ReviewFileDiffPayload;
  /** Last block in the current turn, when that turn touched the file. */
  turnDiff?: ReviewFileDiffPayload;
}

export interface ReviewSummary {
  countsKnown?: boolean;
  files: ReviewCenterFileView[];
  fileCount: number;
  added: number;
  removed: number;
}

export function normalizeReviewPath(path: string): string {
  const normalized = String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}
export function countLineDiff(oldText: string, newText: string): { added: number; removed: number; countsKnown?: boolean } {
  const result = computeLineDiff(oldText, newText);
  return result.countsKnown ? { added: result.added, removed: result.removed }
    : { added: 0, removed: 0, countsKnown: false };
}

/**
 * One hunk per replaced site — the same expansion `extractDiffSites` in
 * `media/chat.js` uses, so a `replace_all` of 148 tokens is +148 −148, not
 * the block-level +1 −1 of the search pattern.
 */
export function extractReviewSites(block: {
  oldText?: string;
  newText?: string;
  _meta?: {
    old_line?: number;
    new_line?: number;
    details?: Array<{
      old_string?: string;
      new_string?: string;
      old_line?: number;
      new_line?: number;
      line_prefix?: string;
    }>;
  };
}): ReviewDiffSite[] {
  const oldText = block.oldText ?? "";
  const newText = block.newText ?? "";
  const meta = block._meta;
  const details = meta && Array.isArray(meta.details) ? meta.details : null;
  if (details && details.length) {
    const sites: ReviewDiffSite[] = [];
    for (const d of details) {
      if (!d || (typeof d.old_string !== "string" && typeof d.new_string !== "string")) continue;
      const old = typeof d.old_string === "string" ? d.old_string : "";
      const nw = typeof d.new_string === "string" ? d.new_string : "";
      const pre = old === "" || typeof d.line_prefix !== "string" ? "" : d.line_prefix;
      sites.push({
        oldText: old === "" ? "" : pre + old,
        newText: pre + nw,
        ...(d.old_line !== undefined ? { oldLine: d.old_line } : {}),
        ...(d.new_line !== undefined ? { newLine: d.new_line } : {}),
      });
    }
    if (sites.length) return sites;
    const first = details[0] || {};
    return [{
      oldText,
      newText,
      ...(first.old_line !== undefined ? { oldLine: first.old_line } : {}),
      ...(first.new_line !== undefined ? { newLine: first.new_line } : {}),
    }];
  }
  return [{
    oldText,
    newText,
    ...(meta && meta.old_line !== undefined ? { oldLine: meta.old_line } : {}),
    ...(meta && meta.new_line !== undefined ? { newLine: meta.new_line } : {}),
  }];
}

function isUsefulSites(oldText: string, newText: string, sites: readonly ReviewDiffSite[]): boolean {
  if (oldText !== newText) return true;
  return sites.some((s) => s && s.oldText !== s.newText);
}


function payloadFrom(block: ReviewDiffBlock): ReviewFileDiffPayload {
  return {
    toolCallId: block.toolCallId,
    oldText: block.oldText,
    newText: block.newText,
    ...(block.replaceAll ? { replaceAll: true } : {}),
    sites: block.sites,
  };
}

function normalizeReviewStatus(raw: unknown): ReviewBlockStatus {
  if (raw === "completed" || raw === "failed") return raw;
  return "pending";
}

type AcpDiffContent = {
  type: "diff";
  path?: string;
  oldText?: string;
  newText?: string;
  _meta?: {
    old_line?: number;
    new_line?: number;
    details?: Array<{
      old_string?: string;
      new_string?: string;
      old_line?: number;
      new_line?: number;
      line_prefix?: string;
    }>;
  };
};

function isDiffContent(block: unknown): block is AcpDiffContent {
  return !!block && typeof block === "object" && (block as { type?: unknown }).type === "diff";
}

/**
 * Fold one tool_call / tool_call_update into the session's review records.
 *
 * Same toolCallId + path replaces (the pre-write echo yields to the
 * completed update, so counts are not doubled). A `failed` call drops its
 * rows. A status-only completed update flips existing rows without needing
 * the diff again.
 */
export function ingestReviewToolCall(
  existing: readonly ReviewDiffBlock[],
  call: unknown,
  turnId: string,
): ReviewDiffBlock[] {
  if (!call || typeof call !== "object") return existing.slice();
  const c = call as {
    toolCallId?: unknown;
    status?: unknown;
    content?: unknown;
    rawInput?: { replace_all?: unknown; replaceAll?: unknown };
  };
  const toolCallId = typeof c.toolCallId === "string" ? c.toolCallId : "";
  if (!toolCallId) return existing.slice();
  const prior = existing.find(b => b.toolCallId === toolCallId);
  const status = c.status === undefined && prior ? prior.status : normalizeReviewStatus(c.status);
  if (status === "failed") return existing.filter((b) => b.toolCallId !== toolCallId);

  const replaceAll = c.rawInput?.replace_all === true || c.rawInput?.replaceAll === true;
  const content = Array.isArray(c.content) ? c.content : [];
  const diffs = content.filter(isDiffContent);
  if (!diffs.length) {
    if (status === "completed") {
      return existing.map((b) => (
        b.toolCallId === toolCallId && b.status !== "completed" ? { ...b, status: "completed" } : b
      ));
    }
    return existing.slice();
  }

  const next = existing.map(b => b.toolCallId === toolCallId && status === "completed" ? { ...b, status } : b);
  const tid = prior?.turnId ?? String(turnId || "");
  for (const d of diffs) {
    const path = normalizeReviewPath(typeof d.path === "string" ? d.path : "");
    if (!path) continue;
    const oldText = typeof d.oldText === "string" ? d.oldText : "";
    const newText = typeof d.newText === "string" ? d.newText : "";
    const sites = extractReviewSites({ oldText, newText, _meta: d._meta });
    const index = next.findIndex(b => b.toolCallId === toolCallId && normalizeReviewPath(b.path) === path);
    const previous = index >= 0 ? next[index] : undefined;
    if (!isUsefulSites(oldText, newText, sites)) continue;
    const replacement: ReviewDiffBlock = {
      path,
      oldText,
      newText,
      sites,
      ...(replaceAll ? { replaceAll: true } : {}),
      toolCallId,
      turnId: tid,
      status,
      nativePath: (d._meta as { reviewOriginalPath?: string } | undefined)?.reviewOriginalPath ?? previous?.nativePath,
      fileOperation: ["add", "delete", "update"].includes((d._meta as { kind?: string } | undefined)?.kind ?? "")
        ? (d._meta as { kind: "add" | "delete" | "update" }).kind : undefined,
      oldTextMissing: (d.oldText == null && (d._meta as { kind?: string } | undefined)?.kind !== "add") || (d._meta as { oldTextMissing?: boolean } | undefined)?.oldTextMissing === true,
      ...(previous?.reviewRoot ? { reviewRoot: previous.reviewRoot } : {}),
      ...(previous?.reviewBefore ? { reviewBefore: previous.reviewBefore } : {}),
      ...(previous?.reviewSessionBefore ? { reviewSessionBefore: previous.reviewSessionBefore } : {}),
      ...(previous?.oldText === oldText && previous.newText === newText && previous.reviewAfter ? { reviewAfter: previous.reviewAfter } : {}),
    };
    if (index >= 0) next[index] = replacement;
    else next.push(replacement);
  }
  return next;
}

export function dropReviewPath(
  existing: readonly ReviewDiffBlock[],
  path: string,
  opts?: { turnId?: string; toolCallId?: string },
): ReviewDiffBlock[] {
  const rel = normalizeReviewPath(path);
  return existing.filter((b) => {
    if (normalizeReviewPath(b.path) !== rel) return true;
    if (opts?.toolCallId && b.toolCallId !== opts.toolCallId) return true;
    if (opts?.turnId && b.turnId !== opts.turnId) return true;
    return false;
  });
}

export function dropReviewTurnsAfter(
  existing: readonly ReviewDiffBlock[],
  surviving: number,
): ReviewDiffBlock[] {
  return existing.filter((b) => {
    const n = Number(b.turnId);
    return !Number.isFinite(n) || n <= surviving;
  });
}

/**
 * Path-deduped file list. `currentTurnId` fills the per-turn columns used by
 * the "this turn" / "session" switcher; omitting it treats everything as
 * the session view.
 */
export function aggregateReviewChanges(
  blocks: readonly ReviewDiffBlock[],
  opts?: { currentTurnId?: string },
): ReviewSummary {
  const currentTurnId = opts?.currentTurnId;
  const byPath = new Map<string, ReviewDiffBlock[]>();
  for (const block of blocks) {
    if (!block || block.status === "failed") continue;
    const path = normalizeReviewPath(block.path);
    if (!path) continue;
    const list = byPath.get(path);
    if (list) list.push(block);
    else byPath.set(path, [block]);
  }
  const files: ReviewCenterFileView[] = [];
  for (const [path, list] of [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const scopeDiff = (entries: ReviewDiffBlock[], sessionScope = false) => {
      if (!entries.length) return undefined;
      const first = entries[0], last = entries[entries.length - 1];
      const baseline = sessionScope ? first.reviewSessionBefore ?? first.reviewBefore : first.reviewBefore;
      if (baseline && last.reviewAfter) {
        const oldText = baseline.text, newText = last.reviewAfter.text;
        return { oldText, newText, source: baseline.source, net: true,
          counts: countLineDiff(oldText, newText),
          payload: { toolCallId: last.toolCallId, oldText, newText, sites: [], net: true } };
      }
      if (entries.length === 1 && !first.oldTextMissing && first.sites.length > 1) {
        const counts = first.sites.map(site => countLineDiff(site.oldText, site.newText));
        return { oldText: first.oldText, newText: first.newText, source: "native", net: true,
          counts: { added: counts.reduce((sum, n) => sum + n.added, 0), removed: counts.reduce((sum, n) => sum + n.removed, 0),
            countsKnown: counts.every(n => n.countsKnown !== false) }, payload: payloadFrom(first) };
      }
      // An exact chain of region edits is also a reconstructible comparison.
      const chain = entries.every((block, i) => !block.oldTextMissing && !block.replaceAll
        && block.sites.length <= 1 && (!i || entries[i - 1].newText === block.oldText)
        && (!i || entries[i - 1].sites[0]?.newLine === block.sites[0]?.oldLine));
      if (chain) {
        const oldText = first.oldText, newText = last.newText;
        return { oldText, newText, source: "native", net: true,
          counts: countLineDiff(oldText, newText), payload: { ...payloadFrom(last), oldText, newText,
            sites: [{ oldText, newText, oldLine: first.sites[0]?.oldLine, newLine: last.sites[0]?.newLine }] } };
      }
      return { oldText: first.oldText, newText: last.newText, source: "unknown", net: false,
        counts: { added: 0, removed: 0, countsKnown: false }, payload: payloadFrom(last) };
    };
    const sessionDiff = scopeDiff(list, true)!;
    const turnList = list.filter(block => block.turnId === currentTurnId);
    const turnDiff = scopeDiff(turnList);
    if (sessionDiff.net && sessionDiff.oldText === sessionDiff.newText
      && (!turnDiff || (turnDiff.net && turnDiff.oldText === turnDiff.newText))) continue;
    files.push({
      path, added: sessionDiff.counts.added, removed: sessionDiff.counts.removed,
      turnAdded: turnDiff?.counts.added ?? 0, turnRemoved: turnDiff?.counts.removed ?? 0,
      countsKnown: sessionDiff.counts.countsKnown !== false,
      turnCountsKnown: turnDiff ? turnDiff.counts.countsKnown !== false : true,
      netAvailable: sessionDiff.net, turnNetAvailable: turnDiff?.net ?? false,
      baselineSource: sessionDiff.source,
      completed: list.every(block => block.status === "completed"),
      turnCompleted: turnList.length > 0 && turnList.every(block => block.status === "completed"),
      diff: sessionDiff.payload, ...(turnDiff ? { turnDiff: turnDiff.payload } : {}),
    });
  }
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  return { files, fileCount: files.length, added, removed, ...(files.some(file => file.countsKnown === false) ? { countsKnown: false } : {}) };
}

export function reviewCenterSnapshot(
  blocks: readonly ReviewDiffBlock[],
  currentTurnId: string,
): ReviewCenterFileView[] {
  return aggregateReviewChanges(blocks, { currentTurnId }).files;
}

export function formatReviewHeadline(fileCount: number, added: number, removed: number): string {
  const noun = fileCount === 1 ? "file" : "files";
  return `${fileCount} ${noun} · +${added} −${removed}`;
}

export function filesForScope(
  files: readonly ReviewCenterFileView[],
  scope: ReviewScope,
): ReviewCenterFileView[] {
  if (scope === "session") return files.filter((f) => f.countsKnown === false || f.added !== 0 || f.removed !== 0);
  return files.filter((f) => (f.turnCountsKnown === false && !!f.turnDiff) || f.turnAdded !== 0 || f.turnRemoved !== 0);
}

export function headlineForScope(
  files: readonly ReviewCenterFileView[],
  scope: ReviewScope,
): { fileCount: number; added: number; removed: number; text: string } {
  const rows = filesForScope(files, scope);
  let added = 0;
  let removed = 0;
  for (const f of rows) {
    added += scope === "turn" ? f.turnAdded : f.added;
    removed += scope === "turn" ? f.turnRemoved : f.removed;
  }
  return {
    fileCount: rows.length,
    added,
    removed,
    text: rows.some(file => (scope === "turn" ? file.turnCountsKnown : file.countsKnown) === false)
      ? `${rows.length} files · changes unavailable` : formatReviewHeadline(rows.length, added, removed),
  };
}

function asDiffSite(site: ReviewDiffSite): DiffSite {
  return {
    oldText: site.oldText,
    newText: site.newText,
    ...(site.oldLine !== undefined ? { oldLine: site.oldLine } : {}),
    ...(site.newLine !== undefined ? { newLine: site.newLine } : {}),
  };
}

/**
 * What discarding ONE file should write, given every completed block for
 * that path in chronological order. Each block is reversed in memory via
 * {@link planEditRevert}; a conflict anywhere fails the whole file — there
 * is no half-reverted intermediate on disk.
 */
export function planFileRevert(
  blocks: readonly ReviewDiffBlock[],
  currentText: string | undefined,
): EditRevertPlan {
  const ordered = blocks.filter((b) => b && b.status === "completed");
  if (!ordered.length) return { action: "conflict" };
  let text: string | undefined = currentText;
  let lastDelete: EditRevertPlan | undefined;
  for (let i = ordered.length - 1; i >= 0; i--) {
    const block = ordered[i];
    const plan = planEditRevert({
      oldText: block.oldText,
      newText: block.newText,
      replaceAll: block.replaceAll,
      sites: block.sites.map(asDiffSite),
      currentText: text,
    });
    if (plan.action === "write") {
      text = plan.text;
      lastDelete = undefined;
      continue;
    }
    if (plan.action === "delete" || plan.action === "delete-confirm") {
      text = undefined;
      lastDelete = plan;
      continue;
    }
    return plan;
  }
  if (text === undefined) return lastDelete ?? { action: "delete" };
  return { action: "write", text };
}

export function completedBlocksForPath(
  blocks: readonly ReviewDiffBlock[],
  path: string,
  scope: ReviewScope,
  currentTurnId: string,
): ReviewDiffBlock[] {
  const rel = normalizeReviewPath(path);
  return blocks.filter((b) => {
    if (normalizeReviewPath(b.path) !== rel) return false;
    if (b.status !== "completed") return false;
    if (scope === "turn" && b.turnId !== currentTurnId) return false;
    return true;
  });
}

/**
 * Discard-all is a checkpoint restore, never a list of per-file reverts.
 * The host loads those turns and runs `planRestoreDetailed`. `unavailable`
 * means there is no snapshot to apply — the caller must not fall back to
 * N `planEditRevert`s, which is not atomic under conflicts.
 */
export function planDiscardAll(
  scope: ReviewScope,
  currentTurnId: string,
): { kind: "checkpoint"; mode: "turn" | "session"; turnId: string } | { kind: "unavailable" } {
  const turnId = String(currentTurnId || "");
  if (scope === "turn") {
    const n = Number(turnId);
    if (!Number.isFinite(n) || n < 1) return { kind: "unavailable" };
    return { kind: "checkpoint", mode: "turn", turnId };
  }
  return { kind: "checkpoint", mode: "session", turnId: turnId || "1" };
}
