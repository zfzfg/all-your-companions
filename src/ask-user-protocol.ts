/**
 * AP-05 — the wire between the CLI-spawned `ask_user` MCP server and this host.
 *
 * Pure by construction: no `net`, no `child_process`, no clock. Everything here
 * is shared by three places that must agree byte for byte — the host pipe
 * server ([ask-user-server.ts](./ask-user-server.ts)), the shipped stdio script
 * (`resources/mcp/ask-user-server.cjs`), and the tests. The script cannot
 * `import` this file (it runs as plain CJS out of the VSIX, with no build step
 * of its own), so it re-states the same constants; `test/ask-user-server.test.ts`
 * pins the two copies against each other.
 *
 * Two design rules run through the whole file:
 *
 * 1. **Tolerance over strictness.** A schema that rejects makes the model avoid
 *    the tool or fail the turn (market report §3.3, Kilo and OpenCode). A missing
 *    `header` is derived, missing `options` means free text, out-of-range counts
 *    are trimmed rather than refused. Only a missing `question` is an error, and
 *    even that comes back as a tool RESULT, never as a throw.
 * 2. **Nothing here trusts its input.** Both ends receive JSON written by another
 *    process; every field is re-validated on arrival on both sides.
 */

/** Server name announced to the CLI. */
export const ASK_USER_SERVER_NAME = "companions";

/** MCP tool name. Exactly one tool — decision §18.2. */
export const ASK_USER_TOOL_NAME = "ask_user";

/** Env var carrying the pipe/socket address. Never an argv entry: the process
 *  list is world-readable, and on Windows a named pipe has no file permissions
 *  at all, so the address plus the token IS the access control. */
export const ASK_USER_ADDRESS_ENV = "COMPANIONS_ASK_USER_ADDRESS";
/** Env var carrying the per-session bearer token. Same reason as the address. */
export const ASK_USER_TOKEN_ENV = "COMPANIONS_ASK_USER_TOKEN";

/** Bumped only on an incompatible frame change; the host refuses a mismatch. */
export const ASK_USER_IPC_VERSION = 1;

/** Header cap from the tool schema. Longer headers are trimmed, not rejected. */
export const ASK_USER_HEADER_MAX = 12;
/** Question and option caps. Excess is dropped from the end, never refused. */
export const ASK_USER_MAX_QUESTIONS = 4;
export const ASK_USER_MAX_OPTIONS = 4;

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  /** Empty means a free-text question — the card supplies its own "Other". */
  options: AskUserOption[];
}

export type AskUserNormalizeResult =
  | { ok: true; questions: AskUserQuestion[] }
  | { ok: false; error: string };

/**
 * The tool descriptor sent verbatim in `tools/list`.
 *
 * The description says WHEN to reach for it, not only what it does: an
 * always-available question tool described by its function alone gets called
 * for things the user never wanted to be asked about, and every such call
 * stops the run dead until a human comes back.
 */
export const ASK_USER_TOOL = {
  name: ASK_USER_TOOL_NAME,
  description:
    "Ask the user a question with predefined options. Use ONLY when the answer changes what you do next.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: ASK_USER_MAX_QUESTIONS,
        description: "One to four questions to put to the user at once.",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, as the user will read it." },
            header: {
              type: "string",
              maxLength: ASK_USER_HEADER_MAX,
              description: "Short label for the question. Derived from the question if omitted.",
            },
            multiSelect: { type: "boolean", description: "Allow more than one option to be chosen." },
            options: {
              type: "array",
              minItems: 2,
              maxItems: ASK_USER_MAX_OPTIONS,
              description: "Choices to offer. Omit for a free-text answer.",
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                },
                required: ["label"],
              },
            },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
  },
} as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Shorten a question into a chip-sized header.
 *
 * Word boundary first, so "Which database?" becomes "Which" and not
 * "Which datab" — a cut-off word reads as a rendering fault, an honest short
 * word does not. The hard cut is only for a first word that is already too long.
 */
export function deriveHeader(question: string, max = ASK_USER_HEADER_MAX): string {
  const clean = question.replace(/\s+/g, " ").trim().replace(/[?:.!]+$/, "");
  if (!clean) return "";
  if (clean.length <= max) return clean;
  let out = "";
  for (const word of clean.split(" ")) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > max) break;
    out = next;
  }
  return out || clean.slice(0, max);
}

function normalizeOptions(value: unknown): AskUserOption[] {
  if (!Array.isArray(value)) return [];
  const out: AskUserOption[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (out.length >= ASK_USER_MAX_OPTIONS) break;
    // A bare string is not in the schema, but models send it constantly. Taking
    // it costs nothing; refusing it costs the whole turn.
    const label = typeof raw === "string" ? raw.trim() : trimmedString(asRecord(raw)?.label);
    if (!label) continue;
    // Duplicate labels collapse in the answer map and read as a rendering fault.
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = trimmedString(asRecord(raw)?.description);
    out.push(description ? { label, description } : { label });
  }
  // One lone option is not a choice. Dropping it turns the question into the
  // free-text form, which is still answerable — refusing it would not be.
  return out.length >= 2 ? out : [];
}

/**
 * Validate and repair a `tools/call` argument object.
 *
 * Returns `{ ok: false }` only for input that carries no answerable question at
 * all. Callers turn that into an `isError` tool result whose text is this
 * message, so a confused model reads the reason and can retry inside the turn.
 */
export function normalizeAskUserArguments(args: unknown): AskUserNormalizeResult {
  const record = asRecord(args);
  if (!record) return { ok: false, error: "ask_user needs an object with a `questions` array." };
  // Single-question shorthand: `{ question: "…" }` with no wrapper array.
  const rawList = Array.isArray(record.questions)
    ? record.questions
    : record.question !== undefined
      ? [record]
      : undefined;
  if (!rawList) return { ok: false, error: "ask_user needs a non-empty `questions` array." };

  const questions: AskUserQuestion[] = [];
  for (const raw of rawList) {
    if (questions.length >= ASK_USER_MAX_QUESTIONS) break;
    const item = typeof raw === "string" ? { question: raw } : asRecord(raw);
    if (!item) continue;
    const question = trimmedString(item.question);
    if (!question) continue; // the one hard requirement — reported below if none survive
    const header = trimmedString(item.header).slice(0, ASK_USER_HEADER_MAX) || deriveHeader(question);
    questions.push({
      question,
      header,
      multiSelect: item.multiSelect === true,
      options: normalizeOptions(item.options),
    });
  }
  if (!questions.length) {
    return { ok: false, error: "Every entry in `questions` needs a non-empty `question` string." };
  }
  return { ok: true, questions };
}

/* ------------------------------------------------------------------ frames */

/** Client → host. The first frame on every connection; nothing else is read
 *  until it is accepted. */
export interface AskUserHelloFrame {
  t: "hello";
  v: number;
  token: string;
}
/** Client → host. One outstanding `tools/call`. */
export interface AskUserAskFrame {
  t: "ask";
  id: string;
  questions: AskUserQuestion[];
}
/** Client → host. The CLI cancelled the tool call; drop the card. */
export interface AskUserCancelFrame {
  t: "cancel";
  id: string;
}
export type AskUserClientFrame = AskUserHelloFrame | AskUserAskFrame | AskUserCancelFrame;

/** Host → client. Handshake accepted; asks may start. */
export interface AskUserReadyFrame { t: "ready"; v: number }
/** Host → client. Handshake refused. The client exits on this. */
export interface AskUserDeniedFrame { t: "denied"; reason: string }
/** Host → client. Terminal result for one `ask`. */
export interface AskUserAnswerFrame {
  t: "answer";
  id: string;
  outcome: "accepted" | "cancelled";
  /** Question text → the chosen label(s), joined by ", " for multi-select. */
  answers?: Record<string, string>;
  annotations?: Record<string, { notes?: string; preview?: string }>;
  /** True when a host timeout, not the user, settled the card. */
  auto?: boolean;
}
export type AskUserHostFrame = AskUserReadyFrame | AskUserDeniedFrame | AskUserAnswerFrame;

/**
 * Parse one NDJSON line into a client frame.
 *
 * Returns `undefined` for anything unrecognised — a blank keep-alive line, a
 * frame kind from a newer script, a half-written line after a crash. The
 * connection survives all three; only a refused handshake closes it.
 */
export function parseClientFrame(line: string): AskUserClientFrame | undefined {
  const text = line.trim();
  if (!text) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.t === "hello") {
    const token = trimmedString(record.token);
    if (!token) return undefined;
    return { t: "hello", v: typeof record.v === "number" ? record.v : 0, token };
  }
  if (record.t === "ask") {
    const id = trimmedString(record.id);
    if (!id) return undefined;
    // Re-normalized even though the script already did it: this is another
    // process's JSON, and the card renders exactly what survives here.
    const normalized = normalizeAskUserArguments({ questions: record.questions });
    if (!normalized.ok) return undefined;
    return { t: "ask", id, questions: normalized.questions };
  }
  if (record.t === "cancel") {
    const id = trimmedString(record.id);
    return id ? { t: "cancel", id } : undefined;
  }
  return undefined;
}

/** Serialize a frame as one NDJSON line (trailing newline included). */
export function encodeFrame(frame: AskUserHostFrame | AskUserClientFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Decide a handshake.
 *
 * Constant-time comparison is deliberately NOT used: reaching the pipe at all
 * already requires local access, and a timing-safe compare over a
 * variable-length secret needs a length check that leaks the same bit. The real
 * control is that the token is 256 bits of `randomBytes` and exists only in the
 * child's environment block.
 */
export function checkHello(
  frame: AskUserClientFrame | undefined,
  known: (token: string) => boolean,
): { ok: true; token: string } | { ok: false; reason: string } {
  if (!frame || frame.t !== "hello") return { ok: false, reason: "expected a hello frame" };
  if (frame.v !== ASK_USER_IPC_VERSION) return { ok: false, reason: "unsupported protocol version" };
  if (!known(frame.token)) return { ok: false, reason: "unknown token" };
  return { ok: true, token: frame.token };
}

/**
 * Render an answer frame as the MCP tool result the model reads.
 *
 * One line per question, `Question: answer`. Not JSON: the text goes straight
 * into the model's context, where prose survives a summarization pass that a
 * nested object does not. A cancellation is a RESULT, not an error — the model
 * has to keep working, and an `isError` there reads as a broken tool.
 */
export function formatAskUserResult(
  frame: AskUserAnswerFrame,
): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  if (frame.outcome !== "accepted") {
    return {
      content: [{
        type: "text",
        text: frame.auto
          ? "The question timed out and was continued automatically without an answer. Proceed with your best judgement and say which assumption you made."
          : "The user dismissed the question without answering. Proceed with your best judgement and say which assumption you made.",
      }],
    };
  }
  const lines = Object.entries(frame.answers ?? {}).map(([question, answer]) => `${question}: ${answer}`);
  const notes = Object.entries(frame.annotations ?? {})
    .map(([question, annotation]) => (annotation?.notes ? `${question} — note: ${annotation.notes}` : ""))
    .filter(Boolean);
  const body = [...lines, ...notes].join("\n");
  if (!body) return { content: [{ type: "text", text: "The user answered without selecting anything." }] };
  return {
    content: [{
      type: "text",
      text: frame.auto
        ? `The question was continued automatically with the selection already marked:\n${body}`
        : body,
    }],
  };
}

/** Tool result for input we could not repair. Never thrown — see the file head. */
export function askUserErrorResult(
  message: string,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Auto-continue delay for a question card, in ms.
 *
 * `off` (the default) returns `undefined`: a question waits for a person for as
 * long as it takes. Anything unrecognised also means off — a typo in settings
 * must not quietly start dismissing questions.
 */
export function askTimeoutMs(setting: string | undefined): number | undefined {
  switch ((setting ?? "").trim()) {
    case "60s": return 60_000;
    case "5m": return 5 * 60_000;
    case "10m": return 10 * 60_000;
    default: return undefined;
  }
}
