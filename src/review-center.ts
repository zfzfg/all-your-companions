/**
 * Review-center aggregation (AP-09).
 *
 * Diffs in chat are per tool-call. This module folds them into a per-file
 * list with `+N −M`, path-deduped: a file edited three times is one row
 * whose counts are the SUM of the inline diffs, not a net whole-file diff.
 *
 * Pure — no vscode, no fs, no clock. The host tracks the blocks; the webview
 * only renders the snapshot. "Discard file" runs {@link planFileRevert}
 * (chained {@link planEditRevert} in memory, one write). "Discard all" is
 * NOT N of those — it restores the AP-08 checkpoint, which is atomic
 * against conflicts.
 */

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
  oldText: string;
  newText: string;
  sites: ReviewDiffSite[];
  replaceAll?: boolean;
  toolCallId: string;
  turnId: string;
  status: ReviewBlockStatus;
}

export interface ReviewFileDiffPayload {
  toolCallId: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  sites: ReviewDiffSite[];
}

export interface ReviewCenterFileView {
  path: string;
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
  files: ReviewCenterFileView[];
  fileCount: number;
  added: number;
  removed: number;
}

/** Same ceiling as `computeLineDiff` in media/webview-helpers.js. */
const LINE_DIFF_MAX_PRODUCT = 4_000_000;

export function normalizeReviewPath(path: string): string {
  return String(path || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/**
 * LCS added/removed counts, identical to `computeLineDiff` (CRLF-normalized,
 * empty region = 0 lines). The lines themselves stay in the webview; the
 * review panel only needs the magnitudes, and those must match the inline
 * `+N −M` pills.
 */
export function countLineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const norm = (t: string | null | undefined) => (t == null ? "" : String(t).replace(/\r\n?/g, "\n"));
  const o = norm(oldText);
  const n = norm(newText);
  const oldLines = o === "" ? [] : o.split("\n");
  const newLines = n === "" ? [] : n.split("\n");
  const m = oldLines.length;
  const k = newLines.length;
  if (m * k > LINE_DIFF_MAX_PRODUCT) return { added: k, removed: m };
  const dp: Int32Array[] = [];
  for (let i = 0; i <= m; i++) dp.push(new Int32Array(k + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = k - 1; j >= 0; j--) {
      row[j] = oldLines[i] === newLines[j]
        ? next[j + 1] + 1
        : (next[j] >= row[j + 1] ? next[j] : row[j + 1]);
    }
  }
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;
  while (i < m && j < k) {
    if (oldLines[i] === newLines[j]) {
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      removed++;
      i++;
    } else {
      added++;
      j++;
    }
  }
  while (i < m) {
    removed++;
    i++;
  }
  while (j < k) {
    added++;
    j++;
  }
  return { added, removed };
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

function siteCounts(sites: readonly ReviewDiffSite[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const site of sites) {
    const n = countLineDiff(site.oldText, site.newText);
    added += n.added;
    removed += n.removed;
  }
  return { added, removed };
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
  const status = normalizeReviewStatus(c.status);
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

  const next = existing.filter((b) => b.toolCallId !== toolCallId);
  const tid = String(turnId || "");
  for (const d of diffs) {
    const path = normalizeReviewPath(typeof d.path === "string" ? d.path : "");
    if (!path) continue;
    const oldText = typeof d.oldText === "string" ? d.oldText : "";
    const newText = typeof d.newText === "string" ? d.newText : "";
    const sites = extractReviewSites({ oldText, newText, _meta: d._meta });
    if (!isUsefulSites(oldText, newText, sites)) continue;
    next.push({
      path,
      oldText,
      newText,
      sites,
      ...(replaceAll ? { replaceAll: true } : {}),
      toolCallId,
      turnId: tid,
      status,
    });
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
    const sessionCounts = { added: 0, removed: 0 };
    const turnCounts = { added: 0, removed: 0 };
    let last = list[list.length - 1];
    let turnLast: ReviewDiffBlock | undefined;
    let completed = false;
    let turnCompleted = false;
    for (const block of list) {
      const n = siteCounts(block.sites.length ? block.sites : [{ oldText: block.oldText, newText: block.newText }]);
      sessionCounts.added += n.added;
      sessionCounts.removed += n.removed;
      last = block;
      if (block.status === "completed") completed = true;
      if (currentTurnId !== undefined && block.turnId === currentTurnId) {
        turnCounts.added += n.added;
        turnCounts.removed += n.removed;
        turnLast = block;
        if (block.status === "completed") turnCompleted = true;
      }
    }
    files.push({
      path,
      added: sessionCounts.added,
      removed: sessionCounts.removed,
      turnAdded: turnCounts.added,
      turnRemoved: turnCounts.removed,
      completed,
      turnCompleted,
      diff: payloadFrom(last),
      ...(turnLast ? { turnDiff: payloadFrom(turnLast) } : {}),
    });
  }
  let added = 0;
  let removed = 0;
  for (const f of files) {
    added += f.added;
    removed += f.removed;
  }
  return { files, fileCount: files.length, added, removed };
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
  if (scope === "session") return files.filter((f) => f.added !== 0 || f.removed !== 0);
  return files.filter((f) => f.turnAdded !== 0 || f.turnRemoved !== 0);
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
    text: formatReviewHeadline(rows.length, added, removed),
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
