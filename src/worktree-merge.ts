/**
 * Line-level three-way merge for a worktree apply.
 *
 * This does not run `git merge` and it does not write conflict markers into
 * the source checkout. A clean result is text the caller may copy after it
 * re-reads the target. An unclean result, a binary file, or a file past the
 * line cap is reported and left untouched.
 *
 * Pure. No git, no filesystem.
 */

const LINE_CAP = 8000;

export type ThreeWayMerge =
  | { clean: true; text: string }
  | { clean: false; reason: "binary" | "too-large" | "conflict"; conflicts?: number };

interface Hunk {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized) return [];
  const trailing = normalized.endsWith("\n");
  const body = trailing ? normalized.slice(0, -1) : normalized;
  return body.length ? body.split("\n") : [];
}

function suffixLcs(a: string[], b: string[]): number[][] {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

/** Hunks of `edited` against `base`. Each hunk replaces base[baseStart, baseEnd). */
function editHunks(base: string[], edited: string[]): Hunk[] {
  const dp = suffixLcs(base, edited);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < base.length || j < edited.length) {
    if (i < base.length && j < edited.length && base[i] === edited[j]) {
      i += 1;
      j += 1;
      continue;
    }
    const baseStart = i;
    const lines: string[] = [];
    while (i < base.length || j < edited.length) {
      if (i < base.length && j < edited.length && base[i] === edited[j]) break;
      const dropBase = i < base.length && (j >= edited.length || dp[i + 1][j] >= dp[i][j + 1]);
      if (dropBase) i += 1;
      else {
        lines.push(edited[j]);
        j += 1;
      }
    }
    hunks.push({ baseStart, baseEnd: i, lines });
  }
  return hunks;
}

function sameHunk(a: Hunk, b: Hunk): boolean {
  if (a.baseStart !== b.baseStart || a.baseEnd !== b.baseEnd || a.lines.length !== b.lines.length) return false;
  return a.lines.every((line, index) => line === b.lines[index]);
}

function rangesOverlap(a: Hunk, b: Hunk): boolean {
  if (a.baseStart === a.baseEnd && b.baseStart === b.baseEnd) return a.baseStart === b.baseStart;
  if (a.baseStart === a.baseEnd) return a.baseStart > b.baseStart && a.baseStart < b.baseEnd || a.baseStart === b.baseStart;
  if (b.baseStart === b.baseEnd) return b.baseStart > a.baseStart && b.baseStart < a.baseEnd || b.baseStart === a.baseStart;
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  if (!lines.length) return trailingNewline ? "\n" : "";
  return lines.join("\n") + (trailingNewline ? "\n" : "");
}

/**
 * Merge `ours` (the target checkout) and `theirs` (the worktree) against
 * `base`. The same edit on both sides is kept once. Different edits of the
 * same lines are a conflict. The caller writes nothing in that case.
 */
export function threeWayTextMerge(base: string, ours: string, theirs: string): ThreeWayMerge {
  if (base.includes("\0") || ours.includes("\0") || theirs.includes("\0")) return { clean: false, reason: "binary" };
  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);
  if (baseLines.length > LINE_CAP || oursLines.length > LINE_CAP || theirsLines.length > LINE_CAP) {
    return { clean: false, reason: "too-large" };
  }
  if (ours === theirs) return { clean: true, text: ours };
  const left = editHunks(baseLines, oursLines);
  const right = editHunks(baseLines, theirsLines);
  if (!left.length) return { clean: true, text: theirs };
  if (!right.length) return { clean: true, text: ours };

  const taken = new Set<number>();
  const chosen: Hunk[] = [];
  let conflicts = 0;
  for (const hunk of left) {
    const hits = right.map((other, index) => ({ other, index })).filter(({ other }) => rangesOverlap(hunk, other));
    if (!hits.length) {
      chosen.push(hunk);
      continue;
    }
    for (const hit of hits) taken.add(hit.index);
    if (hits.length === 1 && sameHunk(hunk, hits[0].other)) chosen.push(hunk);
    else conflicts += 1;
  }
  for (let index = 0; index < right.length; index += 1) {
    if (!taken.has(index)) chosen.push(right[index]);
  }
  if (conflicts) return { clean: false, reason: "conflict", conflicts };

  chosen.sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of chosen) {
    if (hunk.baseStart < cursor) return { clean: false, reason: "conflict", conflicts: 1 };
    out.push(...baseLines.slice(cursor, hunk.baseStart), ...hunk.lines);
    cursor = hunk.baseEnd;
  }
  out.push(...baseLines.slice(cursor));
  const trailing = base.endsWith("\n") || ours.endsWith("\n") || theirs.endsWith("\n");
  return { clean: true, text: joinLines(out, trailing) };
}
