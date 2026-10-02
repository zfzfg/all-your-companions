/** Bounded Myers line diff shared by host counts and browser previews. */
export interface LineDiffResult {
  lines: Array<{ type: "ctx" | "add" | "del"; text: string }>;
  added: number;
  removed: number;
  truncated: boolean;
  countsKnown: boolean;
}
export function computeLineDiff(oldText: string, newText: string, opts?: { maxProduct?: number; maxWork?: number }): LineDiffResult {
  const split = (text: string) => text == null || text === "" ? [] : String(text).replace(/\r\n?/g, "\n").split("\n");
  const a = split(oldText), b = split(newText);
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const prefix = a.slice(0, start).map(text => ({ type: "ctx" as const, text }));
  const suffix = a.slice(endA).map(text => ({ type: "ctx" as const, text }));
  const m = endA - start, n = endB - start;
  const finish = (middle: LineDiffResult["lines"]): LineDiffResult => ({
    lines: [...prefix, ...middle, ...suffix],
    added: middle.filter(line => line.type === "add").length,
    removed: middle.filter(line => line.type === "del").length,
    truncated: false, countsKnown: true,
  });
  if (!m) return finish(b.slice(start, endB).map(text => ({ type: "add", text })));
  if (!n) return finish(a.slice(start, endA).map(text => ({ type: "del", text })));
  const limit = opts?.maxWork ?? opts?.maxProduct ?? 4_000_000;
  let work = 0, traceEntries = 0;
  let v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (let d = 0; d <= m + n; d++) {
    // Bound traceback memory separately from comparisons (Map entries are not cheap).
    traceEntries += v.size;
    if (traceEntries > 250_000) return { lines: [], added: 0, removed: 0, truncated: true, countsKnown: false };
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      if (++work > limit) return { lines: [], added: 0, removed: 0, truncated: true, countsKnown: false };
      const left = v.get(k - 1) ?? -Infinity, right = v.get(k + 1) ?? -Infinity;
      let x = k === -d || (k !== d && left < right) ? right : left + 1;
      let y = x - k;
      while (x < m && y < n && a[start + x] === b[start + y]) {
        x++; y++;
        if (++work > limit) return { lines: [], added: 0, removed: 0, truncated: true, countsKnown: false };
      }
      v.set(k, x);
      if (x >= m && y >= n) {
        const middle: LineDiffResult["lines"] = [];
        for (let depth = d; depth >= 0; depth--) {
          const previous = trace[depth], diagonal = x - y;
          const prevK = diagonal === -depth || (diagonal !== depth && (previous.get(diagonal - 1) ?? -Infinity) < (previous.get(diagonal + 1) ?? -Infinity)) ? diagonal + 1 : diagonal - 1;
          const prevX = previous.get(prevK) ?? 0, prevY = prevX - prevK;
          while (x > prevX && y > prevY) { middle.push({ type: "ctx", text: a[start + --x] }); y--; }
          if (!depth) break;
          if (x === prevX) middle.push({ type: "add", text: b[start + --y] });
          else middle.push({ type: "del", text: a[start + --x] });
        }
        return finish(middle.reverse());
      }
    }
  }
  return { lines: [], added: 0, removed: 0, truncated: true, countsKnown: false };
}
