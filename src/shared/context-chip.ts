/** Metadata-only presentation, including unknown future chip kinds. */
export interface ChipView {
kind?: string; relPath?: string; originRelPath?: string; path?: string;
count?: number; severity?: string; scope?: string; label?: string; bytes?: number;
provider?: string; model?: string; modelName?: string;
}
function contextChipKind(chip: ChipView | null | undefined) {
  const kind = chip && chip.kind;
  return kind === "diagnostics" || kind === "terminal" || kind === "subagent" ? kind : "file";
}

function chipBasename(p: string | undefined) {
  return String(p || "").split(/[\\/]/).pop() || String(p || "");
}

function chipPlural(n: number, noun: string) {
  return n + " " + noun + (n === 1 ? "" : "s");
}

function chipSeverityNoun(severity: string | undefined) {
  return severity === "error" ? "error" : severity === "warning" ? "warning" : "problem";
}

/** Human-readable size for a terminal capture ("812 B", "4.1 KB"). */
export function formatChipBytes(bytes: number | undefined) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return Math.round(bytes) + " B";
  const kb = bytes / 1024;
  if (kb < 1024) return (kb < 10 ? kb.toFixed(1) : String(Math.round(kb))) + " KB";
  const mb = kb / 1024;
  return (mb < 10 ? mb.toFixed(1) : String(Math.round(mb))) + " MB";
}

/** The chip's visible text. File chips get the bare basename — the caller
 *  adds the `:12-40` range suffix, which only files have. */
export function contextChipLabel(chip: ChipView) {
  const kind = contextChipKind(chip);
  if (kind === "subagent") return chip.modelName || chip.model || "Subagent";
  if (kind === "diagnostics") {
    const head = chipPlural(chip.count || 0, chipSeverityNoun(chip.severity));
    return chip.scope === "file" && chip.path ? head + " in " + chipBasename(chip.path) : head;
  }
  if (kind === "terminal") return "Terminal: " + (chip.label || "Terminal");
  return chipBasename(chip && chip.relPath);
}

/** The chip's hover text. */
export function contextChipTitle(chip: ChipView) {
  const kind = contextChipKind(chip);
  if (kind === "subagent") return `${chip.provider} · ${chip.model} — Subagent for this message`;
  if (kind === "diagnostics") {
    const where = chip.scope === "file" && chip.path ? chip.path : "the whole workspace";
    return chipPlural(chip.count || 0, chipSeverityNoun(chip.severity))
      + " in " + where + " — collected again when you send";
  }
  if (kind === "terminal") {
    return 'Output of terminal "' + (chip.label || "Terminal") + '" ('
      + formatChipBytes(chip.bytes) + ") — collected again when you send";
  }
  return (chip && (chip.originRelPath || chip.path)) || "";
}
