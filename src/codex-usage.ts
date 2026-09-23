import { closeSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { codexSubscriptionWindows, type SubscriptionWindow } from "./subscription-usage";

/**
 * Read Codex's account rate-limit windows out of its own session rollouts.
 *
 * WHY A FILE. Codex's app-server sends `account/rateLimits/updated`, and
 * `@agentclientprotocol/codex-acp` files it into private session state for its
 * `/status` markdown and returns `null` to the ACP client (measured 2026-09-14).
 * There is no method to ask, and the one structured route the adapter does
 * expose — the `/usage`-style command — is a PROMPT, which would occupy the
 * session and write markdown into the user's transcript to fill in a popover.
 * So the rollout is not a shortcut around a wire API; it is the only source.
 *
 * WHY NOT THIS SESSION'S ROLLOUT. The number is account-wide, not per session,
 * and the popover's whole point is to answer "how much have I got left" BEFORE
 * spending any of it — the moment when this session has written nothing. So the
 * freshest observation of the account wins, whichever session made it, and
 * "Observed <time>" in the panel is what makes an older one honest rather than
 * misleading.
 *
 * WHY THE NEWEST FILE IS NOT THE NEWEST OBSERVATION. A rollout is NAMED when its
 * session starts and appended to until that session ends, so sessions overlap
 * and the name orders starts, not writes. Measured in this tree on 2026-09-13:
 * `rollout-2026-09-13T23-51-19-…` last wrote 55% at 00:51 the next morning,
 * while `rollout-2026-09-13T23-58-16-…` — a later name — last wrote 41% at
 * 22:27. Taking the first file that had any snapshot published 41% as the
 * current account figure, understating it by fourteen points with no sign
 * anything was wrong. The name still decides what to READ, because it is the
 * only ordering available without stat'ing every file; the event's own timestamp
 * decides what to BELIEVE.
 *
 * WHY A TAIL. Rollouts reach tens of megabytes (47 MB measured on this box), and
 * this runs when a popover opens. `token_count` is written at the end of every
 * turn, so the last one is near the end of the file; a file whose tail has none
 * is skipped rather than read whole. Nothing here ever holds a rollout in memory.
 */

export interface CodexUsageFs {
  readdirSync(dir: string): string[];
  statSync(p: string): { isDirectory(): boolean };
  /** The last `bytes` of a file, decoded as utf8. Empty string when unreadable. */
  readTail(file: string, bytes: number): string;
}

export const defaultCodexUsageFs: CodexUsageFs = {
  readdirSync: (dir) => readdirSync(dir) as string[],
  statSync: (p) => statSync(p),
  readTail: (file, bytes) => {
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const size = statSync(file).size;
      const length = Math.min(bytes, size);
      if (length <= 0) return "";
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } catch {
      return "";
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* already gone */ }
    }
  },
};

/** Enough to clear one turn's trailing output on any ordinary turn, and small
 *  enough that scanning several files is still one popover's worth of work. */
export const CODEX_ROLLOUT_TAIL_BYTES = 512 * 1024;
/** Both caps exist so a machine with years of history costs the same as a fresh
 *  one. A number older than the newest few sessions would be stale anyway. */
const MAX_FILES_SCANNED = 8;
const MAX_DAYS_SCANNED = 14;

const descending = (a: string, b: string): number => (a < b ? 1 : a > b ? -1 : 0);

function subdirectories(fs: CodexUsageFs, dir: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => {
      try { return fs.statSync(path.join(dir, name)).isDirectory(); } catch { return false; }
    })
    .sort(descending);
}

/** `sessions/YYYY/MM/DD`, newest first. The names are zero-padded numbers, so
 *  a lexical sort IS chronological and nothing has to be stat'd for mtime. */
function dayDirectories(fs: CodexUsageFs, sessionsRoot: string): string[] {
  const days: string[] = [];
  for (const year of subdirectories(fs, sessionsRoot)) {
    const yearDir = path.join(sessionsRoot, year);
    for (const month of subdirectories(fs, yearDir)) {
      const monthDir = path.join(yearDir, month);
      for (const day of subdirectories(fs, monthDir)) {
        days.push(path.join(monthDir, day));
        if (days.length >= MAX_DAYS_SCANNED) return days;
      }
    }
  }
  return days;
}

/** Rollout filenames embed an ISO timestamp, so this sorts chronologically too. */
function rolloutsIn(fs: CodexUsageFs, dir: string): string[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))
    .sort(descending)
    .map((name) => path.join(dir, name));
}

/**
 * The last usable rate-limit snapshot in a chunk of rollout JSONL.
 *
 * The chunk starts mid-file, so its first line is a fragment and is dropped —
 * without that, one `JSON.parse` of a half-object is thrown per call. Scanning
 * backwards stops at the first line that parses, which is the most recent.
 */
export function rateLimitsFromRolloutTail(chunk: string): SubscriptionWindow[] {
  const lines = chunk.split("\n");
  lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Cheap reject before parsing: most lines in a rollout are model output.
    if (!line || line.indexOf('"rate_limits"') < 0) continue;
    let event: any;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.payload?.type !== "token_count") continue;
    const windows = codexSubscriptionWindows(event.payload.rate_limits, event.timestamp);
    if (windows.length) return windows;
  }
  return [];
}

/**
 * The freshest snapshot in the newest-named files Codex has, by the events' own
 * timestamps rather than by filename — see WHY THE NEWEST FILE IS NOT THE NEWEST
 * OBSERVATION above. That means every file in the bounded set is read rather
 * than stopping at the first hit; measured at 18 ms for all eight on a real
 * `~/.codex`, against 10 ms for one, which is nothing beside being wrong.
 *
 * `[]` for every failure — a missing tree, a vendor format change, a machine
 * that has never run Codex — because the panel's honest answer to "we could not
 * read this" is the same as "there is nothing yet".
 */
export function readCodexSubscriptionWindows(deps: {
  codexHome: string;
  fs?: CodexUsageFs;
  tailBytes?: number;
}): SubscriptionWindow[] {
  const fs = deps.fs ?? defaultCodexUsageFs;
  const tailBytes = deps.tailBytes ?? CODEX_ROLLOUT_TAIL_BYTES;
  const sessionsRoot = path.join(deps.codexHome, "sessions");
  let scanned = 0;
  let freshest: SubscriptionWindow[] = [];
  for (const day of dayDirectories(fs, sessionsRoot)) {
    for (const file of rolloutsIn(fs, day)) {
      if (scanned++ >= MAX_FILES_SCANNED) return freshest;
      const windows = rateLimitsFromRolloutTail(fs.readTail(file, tailBytes));
      // Both windows of one snapshot share the event's timestamp, and every
      // observedAt is a normalized ISO instant, so this compares as text.
      if (windows.length && (!freshest.length || windows[0].observedAt > freshest[0].observedAt)) {
        freshest = windows;
      }
    }
  }
  return freshest;
}
