/**
 * Pure helpers for Grok's rewind surface (`_x.ai/rewind/*`).
 *
 * Wire format (probe-confirmed on CLI 0.2.111 — see research/rewind.md):
 *   points  { sessionId } → { rewind_points: RewindPoint[] }  (snake_case fields)
 *   execute { sessionId, targetPromptIndex, mode?, force? }
 *           → { success, target_prompt_index, mode, reverted_files, clean_files,
 *               conflicts, prompt_text, error }
 *
 * Methods are `_`-prefixed on the wire; bare `x.ai/...` is -32601.
 * `force: true` is required for the execute to actually truncate (without it
 * the CLI returns success:false with empty arrays — the TUI confirmation gate).
 *
 * Legacy user-bubble mapping: hidden primers and other historical non-bubbled
 * turns still create rewind points. `userFacingRewindPoints` strips those so
 * the Nth visible user bubble aligns with the Nth user-facing point.
 */

import { execFile } from "node:child_process";
import { isPrimerText } from "./grok-primer";
import type { HostMsg } from "./protocol";
import { unwrapExtResult } from "./worktree";

export function historyEventCount(messages: readonly HostMsg[]): number {
  return messages.reduce(
    (count, message) => count + (
      message.type === "thoughtChunk" ||
      message.type === "messageChunk" ||
      message.type === "toolCall" ||
      message.type === "toolCallUpdate"
        ? 1
        : 0
    ),
    0,
  );
}

/** Modes the execute RPC accepts (serde enum on the wire). */
export type RewindMode = "all" | "conversation_only" | "code_only" | "files_only";

export const REWIND_MODES: readonly RewindMode[] = [
  "all",
  "conversation_only",
  "code_only",
  "files_only",
];

export interface RewindPoint {
  promptIndex: number;
  createdAt: string;
  numFileSnapshots: number;
  hasFileChanges: boolean;
  promptPreview: string;
}

export interface RewindExecuteResult {
  success: boolean;
  targetPromptIndex: number;
  mode: RewindMode | string;
  revertedFiles: string[];
  cleanFiles: string[];
  conflicts: unknown[];
  promptText: string | null;
  error: string | null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function strArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

/** Parse one rewind point row (snake_case wire → camelCase). */
export function parseRewindPoint(raw: unknown): RewindPoint | null {
  const r = asRecord(raw);
  if (!r) return null;
  const promptIndex =
    typeof r.prompt_index === "number"
      ? r.prompt_index
      : typeof r.promptIndex === "number"
        ? r.promptIndex
        : null;
  if (promptIndex == null || !Number.isFinite(promptIndex) || promptIndex < 0) return null;
  return {
    promptIndex,
    createdAt: str(r.created_at || r.createdAt),
    numFileSnapshots: num(r.num_file_snapshots ?? r.numFileSnapshots, 0),
    hasFileChanges: r.has_file_changes === true || r.hasFileChanges === true,
    promptPreview: str(r.prompt_preview || r.promptPreview),
  };
}

/**
 * Parse `_x.ai/rewind/points` result. Accepts bare `{rewind_points:[…]}`, a
 * double-wrapped `{result:{…}}`, or a bare array of points.
 */
export function parseRewindPoints(payload: unknown): RewindPoint[] {
  const unwrapped = unwrapExtResult(payload);
  if (Array.isArray(unwrapped)) {
    return unwrapped.map(parseRewindPoint).filter((p): p is RewindPoint => !!p);
  }
  const r = asRecord(unwrapped);
  if (!r) return [];
  const list = r.rewind_points ?? r.rewindPoints ?? r.points;
  if (!Array.isArray(list)) return [];
  return list.map(parseRewindPoint).filter((p): p is RewindPoint => !!p);
}

/** Parse `_x.ai/rewind/execute` result. */
export function parseRewindExecute(payload: unknown): RewindExecuteResult | null {
  const r = asRecord(unwrapExtResult(payload));
  if (!r) return null;
  // success is required for a real execute response; if absent, treat as unparseable.
  if (typeof r.success !== "boolean") return null;
  const modeRaw = str(r.mode, "all");
  return {
    success: r.success,
    targetPromptIndex: num(r.target_prompt_index ?? r.targetPromptIndex, 0),
    mode: modeRaw,
    revertedFiles: strArr(r.reverted_files ?? r.revertedFiles),
    cleanFiles: strArr(r.clean_files ?? r.cleanFiles),
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
    promptText:
      typeof r.prompt_text === "string"
        ? r.prompt_text
        : typeof r.promptText === "string"
          ? r.promptText
          : null,
    error:
      typeof r.error === "string"
        ? r.error
        : r.error == null
          ? null
          : String(r.error),
  };
}

/**
 * Format a rewind point for a QuickPick label.
 * Newest-first callers reverse the list themselves; this only formats one row.
 */
/**
 * QuickPick label for a rewind point.
 *
 * `position` is the message's 1-based place among the user's VISIBLE messages.
 * Pass it — in older sessions the wire `promptIndex` counts turns the user cannot
 * see (primer and marker-only verdicts), so labelling with it produces a
 * non-contiguous "#1 #2 … #6 #8" that refers to nothing on screen. Omitted only
 * by callers that have no visible ordering, where the number is dropped rather
 * than shown wrong.
 */
export function formatRewindPointLabel(p: RewindPoint, position?: number): string {
  const preview = (p.promptPreview || "(empty prompt)").replace(/\s+/g, " ").trim();
  const clipped = preview.length > 72 ? preview.slice(0, 69) + "…" : preview;
  const files = p.hasFileChanges
    ? ` · ${p.numFileSnapshots || "?"} file${p.numFileSnapshots === 1 ? "" : "s"}`
    : "";
  const prefix = typeof position === "number" && position > 0 ? `${position}. ` : "";
  return `${prefix}${clipped}${files}`;
}

/** QuickPick detail line (timestamp). */
export function formatRewindPointDetail(p: RewindPoint): string | undefined {
  if (!p.createdAt) return undefined;
  try {
    const d = new Date(p.createdAt);
    if (Number.isNaN(d.getTime())) return p.createdAt;
    return d.toLocaleString();
  } catch {
    return p.createdAt;
  }
}

/**
 * Points that are valid rewind *targets* — every point except the latest one
 * The tip is excluded as a PRODUCT choice, not a wire limitation: execute
 * accepts it fine (probe-verified), but on a user bubble the tip belongs to
 * Edit, which discards that turn AND hands its text back.
 * When only one point exists, returns [] (nothing to rewind to).
 *
 * Pass *all* points (including any legacy primer) so the tip is the true conversation tip;
 * filter with `userFacingRewindPoints` first when picking among user bubbles.
 */
export function selectableRewindPoints(points: RewindPoint[]): RewindPoint[] {
  if (points.length <= 1) return [];
  // Keep chronological order; UI may reverse for newest-first display.
  const maxIdx = Math.max(...points.map((p) => p.promptIndex));
  return points.filter((p) => p.promptIndex < maxIdx);
}

/**
 * True when a rewind point is extension/CLI plumbing that never renders a
 * user bubble — so it must not occupy a slot in the bubble→point map.
 * Mirrors chat.js / `countsAsUserBubble` for previews (truncated OK for primer).
 */
export function isHiddenRewindPoint(p: RewindPoint): boolean {
  const t = p.promptPreview ?? "";
  if (isPrimerText(t)) return true;
  if (/^\s*<system-reminder>/.test(t)) return true;
  // Marker-only plan verdict (no user comment) — no bubble.
  if (/^\s*\[Plan (approved|rejected|cancelled)\]\s*$/i.test(t.trim())) return true;
  return false;
}

/**
 * Rewind points that correspond 1:1 with visible user bubbles (order preserved).
 * The Nth user bubble → `userFacingRewindPoints(all)[N]`.
 */
export function userFacingRewindPoints(points: RewindPoint[]): RewindPoint[] {
  return points.filter((p) => !isHiddenRewindPoint(p));
}

/**
 * Map a 0-based visible user-bubble index to a rewind target.
 * Returns null when the index is out of range or the point is the conversation
 * tip (nothing after it to discard).
 *
 * `allPoints` is the full list from `/points` (legacy primer included) so tip detection
 * uses the real max `prompt_index`.
 */
export function resolveUserBubbleRewind(
  allPoints: RewindPoint[],
  userBubbleIndex: number,
): RewindPoint | null {
  if (!Number.isInteger(userBubbleIndex) || userBubbleIndex < 0) return null;
  const facing = userFacingRewindPoints(allPoints);
  const point = facing[userBubbleIndex];
  if (!point) return null;
  if (allPoints.length === 0) return null;
  const maxIdx = Math.max(...allPoints.map((p) => p.promptIndex));
  // Tip belongs to Edit, not Rewind (a product split — the wire accepts it).
  if (point.promptIndex >= maxIdx) return null;
  return point;
}

/**
 * Rewind target for "edit this message and send it again" (#56).
 *
 * `_x.ai/rewind/execute` **DISCARDS the target prompt** along with everything
 * after it — probe-verified, `research/rewind-semantics-probe.cjs`: a 4-prompt
 * session rewound to #1 dropped to 1 point, and rewound to the tip #3 dropped
 * to 3. The tip is a legal target, so editing the newest message is just a
 * rewind to its own point.
 *
 * The name reads like "rewind TO N, keeping N" — it doesn't, and building on
 * that reading cost the user an extra turn every time. Hence the emphasis here
 * rather than a bare index expression.
 *
 * Returns null only when the bubble maps to no point at all.
 */
export function resolveEditRewindTarget(
  allPoints: RewindPoint[],
  userBubbleIndex: number,
): RewindPoint | null {
  if (!Number.isInteger(userBubbleIndex) || userBubbleIndex < 0) return null;
  // Sort first: bubble N is the Nth point in CONVERSATION order, and
  // `userFacingRewindPoints` preserves input order, so deriving the bubble from
  // an unsorted list picks the wrong turn.
  const sorted = [...allPoints].sort((a, b) => a.promptIndex - b.promptIndex);
  // The target is the message's OWN point — execute discards the target, so
  // this removes exactly this turn. Targeting the predecessor (the natural
  // reading of "rewind TO N keeps N") silently ate an extra turn.
  return userFacingRewindPoints(sorted)[userBubbleIndex] ?? null;
}

/**
 * How many visible user messages survive a rewind to `target`.
 *
 * Execute discards the target and everything after it, so the survivors are the
 * user-facing points strictly BEFORE it. Callers use this to truncate the
 * extension's own per-session history (persisted plan + permission cards), which
 * grok knows nothing about — without it those cards outlive the turns that
 * produced them and get dumped at the bottom of the restored conversation.
 *
 * Works for both entry points: the bubble button and the QuickPick, which picks
 * a point directly and has no bubble index to hand back.
 */
export function survivingUserMessagesAfterRewind(
  allPoints: RewindPoint[],
  target: RewindPoint,
): number {
  return userFacingRewindPoints(allPoints).filter((p) => p.promptIndex < target.promptIndex).length;
}

/**
 * Cut a session's replay buffer at the same point the DOM is cut.
 *
 * `Session.buffer` is what a focus-swap replays to rebuild the chat, so a
 * rewind that only truncates the visible DOM would resurrect the discarded
 * turns the moment the user switched sessions and back.
 *
 * Counts `userMessage` entries, skipping steered ones — they render a bubble
 * but aren't prompts and have no rewind point, exactly as in the DOM. Keeps
 * everything up to (not including) the message that starts the first discarded
 * turn. A buffer with fewer user messages than `surviving` is returned intact.
 */
export function truncateReplayBuffer<T extends { type: string; steer?: boolean }>(
  buffer: T[],
  surviving: number,
): T[] {
  if (surviving < 0) return [];
  let seen = 0;
  for (let i = 0; i < buffer.length; i++) {
    const m = buffer[i];
    if (m.type !== "userMessage" || m.steer) continue;
    if (seen === surviving) return buffer.slice(0, i);
    seen++;
  }
  return buffer;
}

/**
 * Does the wire's user-facing point list still line up with what the user sees?
 *
 * The bubble→point map rests on two heuristics that can drift out from under
 * us: `isHiddenRewindPoint` recognizes plumbing turns by their preview text
 * (legacy primer / system-reminder / bare plan markers), and the webview recognizes
 * steered messages by the CLI's interjection wording. If the CLI adds a new
 * silent turn shape, or rewords an envelope, the lists silently diverge — and a
 * divergence does not error, it targets the WRONG turn and reverts the wrong
 * files.
 *
 * So the counts are compared before executing anything. A mismatch means the
 * map can no longer be trusted, and the honest response is to refuse rather
 * than act on a guess. This turns a future CLI change from a silent data-loss
 * bug into a visible "can't do this" — the failure mode we can live with.
 */
export function bubbleMapIsConsistent(
  allPoints: RewindPoint[],
  totalUserBubbles: number | undefined,
): boolean {
  if (typeof totalUserBubbles !== "number") return true; // older webview: nothing to check
  return userFacingRewindPoints(allPoints).length === totalUserBubbles;
}

/**
 * Will this rewind revert code on disk?
 *
 * `mode: "all"` restores files snapshotted for the target AND every turn after
 * it — so checking the target alone under-reports. Drives whether a confirm is
 * shown at all: a conversation-only rewind hands the message straight back to
 * the composer and needs no dialog, while reverting files is not recoverable
 * from inside the extension and always asks.
 */
export function anyFilesAfter(allPoints: RewindPoint[], target: RewindPoint): boolean {
  return allPoints.some((p) => p.promptIndex >= target.promptIndex && p.hasFileChanges);
}

export type WorkspaceGitStatus = "clean" | "dirty" | "no_git";

export function checkWorkspaceGitStatus(
  workspaceRoot?: string,
  execFn: typeof execFile = execFile,
): Promise<WorkspaceGitStatus> {
  if (!workspaceRoot) return Promise.resolve("no_git");
  return new Promise((resolve) => {
    execFn(
      "git",
      ["status", "--porcelain"],
      {
        cwd: workspaceRoot,
        windowsHide: true,
        timeout: 5000,
      },
      (err, stdout) => {
        if (err) {
          resolve("no_git");
          return;
        }
        if (typeof stdout === "string" && stdout.trim().length > 0) {
          resolve("dirty");
        } else {
          resolve("clean");
        }
      },
    );
  });
}

export function gitStatusWarning(gitStatus?: WorkspaceGitStatus): string {
  if (gitStatus === "no_git") {
    return "This cannot be undone. Warning: This workspace is not a git repository — discarded file changes cannot be recovered!";
  }
  if (gitStatus === "dirty") {
    return "This cannot be undone. Warning: You have uncommitted changes in git — overwritten modifications cannot be recovered!";
  }
  return "This cannot be undone (unless you have the changes in git).";
}

/** Confirm for the Edit flow — different stakes from a plain rewind, so it says
 *  what comes back rather than only what is lost. */
export function editRewindConfirmMessage(
  target: RewindPoint,
  hasFileChanges: boolean,
  gitStatus?: WorkspaceGitStatus,
): string {
  return (
    `Edit your last message?\n\n` +
    `It will be removed from the conversation and put back in the composer so you can change it and send again.\n\n` +
    (hasFileChanges
      ? "Grok's reply to it will be discarded and any files it changed in that turn will be restored.\n"
      : "Grok's reply to it will be discarded. Earlier messages are untouched.\n") +
    gitStatusWarning(gitStatus)
  );
}

/** Confirm dialog body for a chosen target. */
export function rewindConfirmMessage(
  p: RewindPoint,
  mode: RewindMode = "all",
  gitStatus?: WorkspaceGitStatus,
): string {
  const preview = (p.promptPreview || "(empty)").replace(/\s+/g, " ").trim();
  const clipped = preview.length > 120 ? preview.slice(0, 117) + "…" : preview;
  // Execute DISCARDS the target turn as well as everything after it — the old
  // wording ("after this turn") promised the opposite and was wrong on the
  // wire. See resolveEditRewindTarget + research/rewind-semantics-probe.cjs.
  const scope =
    mode === "conversation_only"
      ? "This message and everything after it will be discarded from the conversation."
      : mode === "files_only" || mode === "code_only"
        ? "Files will be restored to the snapshot taken before this turn; conversation stays."
        : "This message and everything after it will be discarded, and files restored to the snapshot taken before it.";
  return (
    `Rewind to this message?\n\n` +
    `"${clipped}"\n\n` +
    `${scope}\n` +
    gitStatusWarning(gitStatus)
  );
}
