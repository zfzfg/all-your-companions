/**
 * Context chips beyond files: the discriminated union the composer stages, and
 * the SEND-TIME serialization of each non-file variant.
 *
 * Three rules shape this module.
 *
 * 1. **`FileChip` is a variant, not a legacy.** Today's chip keeps its name and
 *    its shape and becomes `{ kind?: "file" } & FileChip` — an absent `kind`
 *    IS a file chip, so every persisted draft, replayed buffer and remote frame
 *    written before this existed still reads correctly.
 *
 * 2. **The content is not in the chip.** A diagnostics or terminal chip carries
 *    only what it takes to find the source again plus what the label shows. The
 *    bytes are collected in the host at send (`contextChipPayloads` in
 *    sidebar.ts) and handed to {@link serializeContextChip}. A chip attached ten
 *    minutes ago must not send the state of ten minutes ago — that is the whole
 *    point of the split, and the reason no `text` field exists here to tempt a
 *    caller into caching one.
 *
 * 3. **Nothing here writes into the `<vscode-context>` envelope.**
 *    `parseAttachmentContext` (media/webview-helpers.js) takes the rest of a
 *    `- <path>` line verbatim as a path, and terminal output is full of lines
 *    that begin with `- `. Both variants therefore serialize as FENCED BLOCKS
 *    that sit OUTSIDE the envelope, beside the selection snippets — the same
 *    place, and for the same reason, as the #151 fix. Diagnostic messages are
 *    additionally collapsed to one line, so a multi-line message cannot smuggle
 *    a `- ` line into the prompt either.
 */

import type { FileChip } from "./chips";

// ── The union ────────────────────────────────────────────────────────────────

export type DiagnosticsScope = "file" | "workspace";
/** Which severities a diagnostics chip asked for (not what it found). */
export type DiagnosticsSeverityFilter = "error" | "warning" | "all";
export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

/**
 * Problems reported by the editor's language services.
 *
 * `count` is the number seen AT ATTACH — it is the label's number, never the
 * send's. The send re-reads the source, so the two legitimately differ when the
 * user fixed something in between; that is correct behaviour, not drift.
 */
export interface DiagnosticsChip {
  kind: "diagnostics";
  id: string;
  scope: DiagnosticsScope;
  /** Absolute path of the scoped file. Present only for `scope: "file"`. */
  path?: string;
  severity: DiagnosticsSeverityFilter;
  count: number;
  hidden: boolean;
  /**
   * Plain-text label under a key every chip renderer has always read.
   *
   * Not decoration: a client that predates this union renders chips with
   * `chip.relPath.split(…)` and would throw on a chip without it, taking the
   * whole composer down. Carrying it makes an unknown `kind` degrade to a
   * generic, harmless chip instead — the additive-wire-field rule applied to a
   * field the OLD side reads rather than the new one.
   */
  relPath: string;
}

/** Output of the terminal the user last worked in. */
export interface TerminalChip {
  kind: "terminal";
  id: string;
  /** Terminal name at attach ("bash", "npm run dev"). */
  label: string;
  /** UTF-8 length of the capture at attach — the size shown on the tooltip. */
  bytes: number;
  hidden: boolean;
  /** Same compatibility role as {@link DiagnosticsChip.relPath}. */
  relPath: string;
}

/**
 * Everything the composer can stage.
 *
 * The file variant's `kind` is OPTIONAL on purpose: it is the shape already on
 * disk and on the wire, so widening it must not require rewriting a single
 * existing producer.
 */
export type ContextChip =
  | ({ kind?: "file" } & FileChip)
  | DiagnosticsChip
  | TerminalChip;

export function isFileChip(chip: ContextChip): chip is { kind?: "file" } & FileChip {
  return chip.kind === undefined || chip.kind === "file";
}

export function isDiagnosticsChip(chip: ContextChip): chip is DiagnosticsChip {
  return chip.kind === "diagnostics";
}

export function isTerminalChip(chip: ContextChip): chip is TerminalChip {
  return chip.kind === "terminal";
}

// ── Factories ────────────────────────────────────────────────────────────────

// Same generation scheme as `makeExplicitChip` in chips.ts: a monotonic counter
// keeps two chips of the same source distinguishable, so removing one never
// removes the other.
let contextChipCounter = 0;

function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export function makeDiagnosticsChip(opts: {
  scope: DiagnosticsScope;
  count: number;
  severity?: DiagnosticsSeverityFilter;
  /** Absolute path; required for `scope: "file"`. */
  path?: string;
  /** Workspace-relative path, for the label. */
  relPath?: string;
}): DiagnosticsChip {
  contextChipCounter += 1;
  const severity = opts.severity ?? "all";
  const scope = opts.scope === "file" && opts.path ? "file" : "workspace";
  const chip: DiagnosticsChip = {
    kind: "diagnostics",
    id: `diagnostics:${scope}:${opts.path ?? ""}:${contextChipCounter}`,
    scope,
    severity,
    count: opts.count,
    hidden: false,
    relPath: "",
  };
  if (scope === "file" && opts.path) chip.path = opts.path;
  chip.relPath = diagnosticsChipRelPath(chip, opts.relPath);
  return chip;
}

function diagnosticsChipRelPath(chip: DiagnosticsChip, relPath?: string): string {
  const where = relPath ?? (chip.path ? basename(chip.path) : "");
  return chip.scope === "file" && where ? `Problems in ${where}` : "Problems in the workspace";
}

export function makeTerminalChip(opts: { label: string; bytes: number }): TerminalChip {
  contextChipCounter += 1;
  const label = opts.label.trim() || "Terminal";
  return {
    kind: "terminal",
    id: `terminal:${label}:${contextChipCounter}`,
    label,
    bytes: opts.bytes,
    hidden: false,
    relPath: `Terminal output (${label})`,
  };
}

// ── Label / icon derivation ──────────────────────────────────────────────────

/** Which glyph a chip shows. Mirrors the `ICON` keys in media/chat.js. */
export type ContextChipIcon = "file" | "image" | "diagnostics" | "terminal";

export function contextChipIcon(chip: ContextChip): ContextChipIcon {
  if (isDiagnosticsChip(chip)) return "diagnostics";
  if (isTerminalChip(chip)) return "terminal";
  return chip.imageIndex != null ? "image" : "file";
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function severityNoun(severity: DiagnosticsSeverityFilter): string {
  return severity === "error" ? "error" : severity === "warning" ? "warning" : "problem";
}

/** Human-readable size for a terminal capture ("812 B", "4.1 KB"). */
export function formatChipBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The chip's visible text. File chips get the bare basename — the caller adds
 *  the `:12-40` range suffix, which only files have. */
export function contextChipLabel(chip: ContextChip): string {
  if (isDiagnosticsChip(chip)) {
    const head = plural(chip.count, severityNoun(chip.severity));
    return chip.scope === "file" && chip.path ? `${head} in ${basename(chip.path)}` : head;
  }
  if (isTerminalChip(chip)) return `Terminal: ${chip.label}`;
  return basename(chip.relPath);
}

/** The chip's `title` (hover) text. */
export function contextChipTitle(chip: ContextChip): string {
  if (isDiagnosticsChip(chip)) {
    const where = chip.scope === "file" && chip.path ? chip.path : "the whole workspace";
    return `${plural(chip.count, severityNoun(chip.severity))} in ${where} — collected again when you send`;
  }
  if (isTerminalChip(chip)) {
    return `Output of terminal "${chip.label}" (${formatChipBytes(chip.bytes)}) — collected again when you send`;
  }
  return chip.originRelPath || chip.path;
}

// ── Send-time payloads ───────────────────────────────────────────────────────

/** One editor diagnostic, flattened by the host facade. */
export interface DiagnosticItem {
  /** Workspace-relative where possible, forward slashes. */
  path: string;
  /** 1-based, matching what the Problems panel shows. */
  line: number;
  /** 1-based. */
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  /** Producer ("ts", "eslint") when the language service names one. */
  source?: string;
}

/**
 * What the host collected for one non-file chip, at send.
 *
 * `undefined` from the resolver is a first-class answer: the source vanished,
 * or the host facade threw. The chip then contributes nothing to the prompt —
 * never a header promising content that isn't there.
 */
export type ContextChipPayload =
  | { kind: "diagnostics"; items: readonly DiagnosticItem[] }
  | { kind: "terminal"; label: string; text: string };

/**
 * Rows a diagnostics block prints before it starts counting instead.
 *
 * The bound is applied to the COUNT, before any row is formatted — the cheap
 * check first, then the content, the same order `MAX_SELECTION_LINES` uses on a
 * selection whose line count is known from the range alone.
 */
export const MAX_DIAGNOSTIC_ROWS = 200;

/** Characters of terminal output that reach the prompt. Cut from the FRONT:
 *  a build log's last screen is the one that says what went wrong. */
export const MAX_TERMINAL_CHARS = 20_000;

/** One line of context, `path:line:col  severity  message (source)`. */
function diagnosticRow(item: DiagnosticItem): string {
  // Collapse whitespace: a multi-line message would otherwise put arbitrary
  // text at the start of a line — which is how a `- foo` line ends up read as
  // a file path if this block ever moves inside the envelope (#151).
  const message = item.message.replace(/\s+/g, " ").trim();
  const source = item.source ? ` (${item.source})` : "";
  return `${item.path}:${item.line}:${item.column}  ${item.severity}  ${message}${source}`;
}

/** Group by file, first-appearance order, order within a file preserved. */
function groupByPath(items: readonly DiagnosticItem[]): DiagnosticItem[] {
  const byPath = new Map<string, DiagnosticItem[]>();
  for (const item of items) {
    const bucket = byPath.get(item.path);
    if (bucket) bucket.push(item);
    else byPath.set(item.path, [item]);
  }
  return [...byPath.values()].flat();
}

/** "2 errors, 1 warning" — only the severities actually present, in rank order. */
export function summarizeDiagnostics(items: readonly DiagnosticItem[]): string {
  const order: DiagnosticSeverity[] = ["error", "warning", "info", "hint"];
  const nouns: Record<DiagnosticSeverity, string> = {
    error: "error",
    warning: "warning",
    info: "info message",
    hint: "hint",
  };
  const parts: string[] = [];
  for (const severity of order) {
    const n = items.filter((item) => item.severity === severity).length;
    if (n) parts.push(plural(n, nouns[severity]));
  }
  return parts.join(", ") || "no problems";
}

function serializeDiagnostics(chip: DiagnosticsChip, items: readonly DiagnosticItem[]): string {
  if (!items.length) return "";
  const grouped = groupByPath(items);
  // Decided from the count, before a single row is formatted.
  const capped = grouped.length > MAX_DIAGNOSTIC_ROWS;
  const shown = capped ? grouped.slice(0, MAX_DIAGNOSTIC_ROWS) : grouped;
  const where = chip.scope === "file" && chip.path
    ? `in \`${items[0].path}\``
    : "in the workspace";
  const summary = summarizeDiagnostics(grouped)
    + (capped ? `; first ${MAX_DIAGNOSTIC_ROWS} shown` : "");
  const rows = shown.map(diagnosticRow);
  if (capped) rows.push(`[… ${grouped.length - MAX_DIAGNOSTIC_ROWS} more not shown …]`);
  return `Problems ${where} (${summary}):\n\`\`\`text\n${rows.join("\n")}\n\`\`\``;
}

function serializeTerminal(chip: TerminalChip, label: string, text: string): string {
  if (!text.trim()) return "";
  const capped = text.length > MAX_TERMINAL_CHARS;
  const body = capped
    ? `[… earlier output truncated …]\n${text.slice(text.length - MAX_TERMINAL_CHARS)}`
    : text;
  const size = capped
    ? `last ${MAX_TERMINAL_CHARS} of ${text.length} characters`
    : plural(text.length, "character");
  const name = label.trim() || chip.label;
  return `Terminal output from \`${name}\` (${size}):\n\`\`\`console\n${body}\n\`\`\``;
}

/**
 * Render one non-file chip into the prompt.
 *
 * Returns `""` for anything with nothing to say (empty payload, mismatched
 * payload kind, file chip) — the caller drops empty strings, so a source that
 * emptied between attach and send costs a header and nothing else.
 *
 * The result is always a fenced block and never contains a `<vscode-context>`
 * envelope line; see the module header for why that is load-bearing.
 */
export function serializeContextChip(chip: ContextChip, payload: ContextChipPayload | undefined): string {
  if (!payload) return "";
  if (isDiagnosticsChip(chip) && payload.kind === "diagnostics") {
    return serializeDiagnostics(chip, payload.items);
  }
  if (isTerminalChip(chip) && payload.kind === "terminal") {
    return serializeTerminal(chip, payload.label, payload.text);
  }
  return "";
}
