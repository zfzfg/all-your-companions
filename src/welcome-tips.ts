/**
 * Host-side store for empty-state tips the user is finished with.
 *
 * The tip CATALOGUE — copy, link targets, and the eligibility rule — lives in
 * `media/webview-helpers.js`, because every fact it reads is client state and
 * the chat webview is what renders it.
 * This module is deliberately the other half: it knows nothing about which tips
 * exist, only how to keep a bounded set of ids on disk.
 *
 * That split is the point. A copy of the id list here would be a second
 * registry to keep in sync, and this codebase has already paid for five of
 * those. Instead an unknown id is harmless in both directions: the host stores
 * anything id-shaped, and `welcomeTipById` in the client skips anything it does
 * not recognise. An older host and a newer client therefore need no version
 * check between them.
 */

/** globalState / client-state key. Record map of id -> true, never an array. */
export const WELCOME_TIPS_KEY = "grok.welcomeTips";

/** Companion key: id -> the local day that tip last had its turn. */
export const WELCOME_TIPS_SHOWN_KEY = "grok.welcomeTipsShown";

/**
 * Ceiling on stored ids.
 *
 * The catalogue is single digits, so this is not a product limit — it is the
 * bound that keeps a buggy or hostile client from growing the file without end.
 * Reached only by something that is not the UI, so refusing further writes is
 * the right answer rather than evicting an entry the user actually retired.
 */
export const WELCOME_TIPS_DISMISS_LIMIT = 64;

/**
 * Ids that may become filenames' worth of JSON keys. Alphanumerics, dash and
 * underscore only — no dots, no separators, nothing that could read as a path.
 * The desktop IPC validator caps the length as well; this is the second gate,
 * on the side that actually writes.
 */
const SAFE_TIP_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Whether `id` is storable. Exported so the message handler and the tests
 *  agree on one definition rather than each carrying a regex. */
export function isWelcomeTipId(id: unknown): id is string {
  return typeof id === "string" && SAFE_TIP_ID.test(id);
}

/**
 * The retired ids in a persisted value, sorted for a stable frame.
 *
 * Defensive because the value can be anything the disk holds: a legacy array, a
 * half-written object, `null`. Anything that is not a record of id-shaped keys
 * degrades to "nothing retired", which shows the user a tip they had dismissed
 * — mildly annoying, and strictly better than throwing on the path that builds
 * the welcome screen.
 */
export function parseDismissedTips(raw: unknown): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value !== true) continue;
    if (!isWelcomeTipId(id)) continue;
    out.push(id);
  }
  return out.sort();
}

/**
 * Today, as `YYYY-MM-DD` in the machine's own timezone.
 *
 * Built from LOCAL date parts rather than an ISO string, which is the same
 * correctness the routine scheduler needs and for the same reason: `toISOString`
 * is UTC, so anyone west of Greenwich would roll over to a new "day" in the
 * afternoon and see the whole pool again before dinner.
 */
export function localDayKey(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The id -> day map in a persisted value, ignoring anything ill-shaped. */
export function parseShownTips(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue;
    if (!isWelcomeTipId(id)) continue;
    out[id] = value;
  }
  return out;
}

/** Ids that have already had their turn on `day`. Sorted, for a stable frame. */
export function shownOn(raw: unknown, day: string): string[] {
  return Object.entries(parseShownTips(raw))
    .filter(([, when]) => when === day)
    .map(([id]) => id)
    .sort();
}

/**
 * The map to persist after `id` has been shown on `day`, or null when there is
 * nothing to write.
 *
 * Every OTHER day is dropped on the way through. The file therefore holds at
 * most one entry per tip and needs no eviction policy of its own — yesterday's
 * record has no reader, because the only question ever asked of this store is
 * "did this one already appear today".
 */
export function withShownTip(
  raw: unknown,
  id: unknown,
  day: string,
): Record<string, string> | null {
  if (!isWelcomeTipId(id)) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const current = parseShownTips(raw);
  if (current[id] === day) return null;
  const next: Record<string, string> = {};
  for (const [existing, when] of Object.entries(current)) {
    if (when === day) next[existing] = when;
  }
  next[id] = day;
  return next;
}

/**
 * The record map to persist after retiring `id`, or `null` when there is
 * nothing to write.
 *
 * `null` for an unknown-shaped id, for one already retired, and for a store
 * that has hit the limit — all three mean "do not touch the disk", which also
 * means the caller does not re-broadcast a frame that would be identical. The
 * existing entries are carried through verbatim so a value written by a newer
 * client (one that knows a tip this host does not) survives the round trip.
 */
export function withDismissedTip(
  raw: unknown,
  id: unknown,
): Record<string, true> | null {
  if (!isWelcomeTipId(id)) return null;
  const current = parseDismissedTips(raw);
  if (current.includes(id)) return null;
  if (current.length >= WELCOME_TIPS_DISMISS_LIMIT) return null;
  const next: Record<string, true> = {};
  for (const existing of current) next[existing] = true;
  next[id] = true;
  return next;
}
