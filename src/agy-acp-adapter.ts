import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface, type Interface } from "node:readline";
import { DEFAULT_GEMINI_MODELS, contextWindowForModel, parseAgyModelsOutput, type AgyModelEntry } from "./gemini-backend";
import { MAX_DIFF_EXPAND_BYTES } from "./diff-view";
import { mergeDiffIntoContent, synthesizeEditDiff, type AcpDiffBlock } from "./diff-synthesize";
import { antigravitySettingsPaths } from "./gemini-cli-locator";
import { grokCliNeedsShell, shellSafeCommand } from "./cli-process";
import { abortable, stopAgyProcess, type AgyTurnState } from "./agy-lifecycle";
import { AGY_INITIALIZE_RESULT, agyCliMode, agyTerminalToolUpdate } from "./agy-capabilities";
import { agySkillInstructions, discoverAgySkills, type AgySkillCommand } from "./agy-skills";

/**
 * What `agy` actually does with `--effort`, measured against 1.1.26.
 *
 * A model id either carries its reasoning level in the suffix or takes exactly
 * one `--effort` — never both, and never neither:
 *
 *     --model gemini-3.8-flash                 -> "requires --effort (low, medium, high)"
 *     --model gemini-3.8-flash --effort high   -> ok
 *     --model gemini-3.8-flash-low             -> ok
 *     --model gpt-oss-120b-medium              -> ok
 *     --model gpt-oss-120b-medium --effort high-> "conflicts with --effort=high"
 *
 * So the flag is not optional decoration on the models that group by effort:
 * omitting it fails the session outright, which is why "Default" resolves to a
 * real level here rather than to an absent flag. An id we do not know (a
 * dynamic variant) is assumed to already carry its own level.
 */
function modelRequiresEffort(modelId: string): boolean {
  const known = DEFAULT_GEMINI_MODELS.find((m) => m.modelId === modelId);
  return known ? known._meta.supportsReasoningEffort === true : false;
}

/** Where "Default" lands for a model that insists on a level. The middle one:
 *  the CLI offers no default of its own, and the previous hard-coded `high`
 *  bought maximum thinking on every turn without anyone choosing it. */
export const DEFAULT_AGY_EFFORT = "medium";

function toolKind(name: string): string {
  switch (name) {
    case "write_to_file":
    case "replace_file_content":
    case "multi_replace_file_content":
    case "sed_file":
      return "edit";
    case "run_command":
      return "execute";
    case "grep_search":
    case "search_web":
    case "find_by_name":
      return "search";
    case "view_file":
    case "list_dir":
    case "read_resource":
    case "read_url_content":
    case "read_browser_page":
      return "read";
    default:
      return "other";
  }
}

export function normalizeToolInput(name: string, params: any): Record<string, any> {
  const p = { ...(params || {}) };
  if (p.CommandLine) {
    p.command = p.CommandLine;
    p.cmd = p.CommandLine;
  }
  if (p.TargetFile) {
    p.file_path = p.TargetFile;
    p.path = p.TargetFile;
    p.target_file = p.TargetFile;
  }
  if (p.AbsolutePath) {
    p.file_path = p.AbsolutePath;
    p.path = p.AbsolutePath;
  }
  if (p.DirectoryPath) {
    p.directory = p.DirectoryPath;
    p.target_directory = p.DirectoryPath;
    p.path = p.DirectoryPath;
  }
  if (p.Query) {
    p.pattern = p.Query;
    p.query = p.Query;
  }
  if (p.Pattern) {
    p.pattern = p.Pattern;
    p.glob_pattern = p.Pattern;
  }
  if (p.SearchDirectory) {
    p.path = p.SearchDirectory;
    p.directory = p.SearchDirectory;
  }
  if (p.Url) {
    p.url = p.Url;
    p.uri = p.Url;
  }
  return p;
}

function toolTitle(name: string, params: any): string {
  const p = params || {};
  switch (name) {
    case "write_to_file": {
      const file = p.TargetFile || p.file_path || p.path ? path.basename(p.TargetFile || p.file_path || p.path) : "file";
      return `Create ${file}`;
    }
    case "replace_file_content":
    case "multi_replace_file_content": {
      const file = p.TargetFile || p.file_path || p.path ? path.basename(p.TargetFile || p.file_path || p.path) : "file";
      return `Edit ${file}`;
    }
    case "view_file": {
      const file = p.AbsolutePath || p.file_path || p.path ? path.basename(p.AbsolutePath || p.file_path || p.path) : "file";
      return `Read ${file}`;
    }
    case "list_dir": {
      const dir = p.DirectoryPath || p.directory || p.path ? path.basename(p.DirectoryPath || p.directory || p.path) : "directory";
      return `List ${dir}`;
    }
    case "grep_search": {
      const q = p.Query || p.pattern || p.query;
      return q ? `Search "${q}"` : "grep_search";
    }
    case "find_by_name": {
      const pattern = p.Pattern || p.pattern || p.Query || p.query;
      return pattern ? `Find "${pattern}"` : "find_by_name";
    }
    case "search_web": {
      const q = p.Query || p.pattern || p.query;
      return q ? `Web search "${q}"` : "search_web";
    }
    case "run_command": {
      const cmd = p.CommandLine || p.command || p.cmd;
      return cmd ? cmd.split(/\r?\n/)[0].slice(0, 80) : "run_command";
    }
    default:
      return name;
  }
}

/**
 * Normalize an absolute file path for use as a baseline cache key.
 * On Windows, paths are case-insensitive and slashes must be consistent.
 */
export function normalizeBaselineKey(file: string, cwd: string): string {
  const resolved = path.isAbsolute(file) ? path.normalize(file) : path.normalize(path.resolve(cwd, file));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Automatically seeds Antigravity tool guidelines into ~/.gemini/config/rules/
 * and ~/.gemini/GEMINI.md if missing or empty.
 *
 * This prevents Gemini models from:
 * 1. Attaching ArtifactMetadata to normal workspace files (causing Cortex permission error).
 * 2. Calling find_by_name without the mandatory Pattern argument.
 * 3. Calling file tools with relative paths instead of absolute paths.
 */
export function ensureAntigravityToolRules(geminiHome: string): boolean {
  try {
    const rulesDir = path.join(geminiHome, "config", "rules");
    const ruleFile = path.join(rulesDir, "antigravity_tool_rules.md");
    const geminiMd = path.join(geminiHome, "GEMINI.md");

    const content = `---
description: Critical guidelines for Antigravity and Cortex tool usage
always_on: true
---

# Antigravity & Cortex Tool Calling Guidelines

Follow these strict rules when invoking tools:

## 1. File Writing (write_to_file)
- NEVER provide ArtifactMetadata when creating or modifying files in the workspace or project directory.
- ArtifactMetadata is STRICTLY reserved for internal session artifacts inside <geminiHome>/brain/<conversation-id>/ (e.g. implementation_plan.md, walkthrough.md).
- Passing ArtifactMetadata for any workspace file causes an immediate fatal Cortex permission rejection ("is not a valid artifact path"). All regular workspace files must ALWAYS be written without ArtifactMetadata.

## 2. File Finding (find_by_name)
- The Pattern parameter is MANDATORY in find_by_name.
- Even when filtering by Extensions (e.g. ["mp3", "wav"]) or specifying SearchDirectory, you MUST ALWAYS provide Pattern: "*" (or a specific glob pattern).
- Omitting Pattern triggers an immediate schema validation error: "missing property 'Pattern'".

## 3. File Viewing and Searching (view_file, grep_search, list_dir)
- Always use absolute paths for AbsolutePath, SearchPath, DirectoryPath, and TargetFile.
- When searching with grep_search, always supply both SearchPath and Query.
`;

    let modified = false;
    if (!fs.existsSync(ruleFile)) {
      fs.mkdirSync(rulesDir, { recursive: true });
      fs.writeFileSync(ruleFile, content, "utf8");
      modified = true;
    }

    if (!fs.existsSync(geminiMd)) {
      fs.writeFileSync(geminiMd, content, "utf8");
      modified = true;
    }
    return modified;
  } catch {
    return false;
  }
}

/**
 * Normalizes and clarifies internal Cortex engine errors for user display.
 */
export function sanitizeAgyToolErrorMessage(rawMessage: any): any {
  if (typeof rawMessage === "string") {
    if (/not a valid artifact path/i.test(rawMessage)) {
      return "Tool call rejected: ArtifactMetadata is invalid for a workspace file. The model must retry without ArtifactMetadata.";
    }
    if (/missing property ['"]Pattern['"]/i.test(rawMessage)) {
      return "Tool call rejected: Missing required property 'Pattern'. The model must retry with a glob pattern such as '*'.";
    }
    return rawMessage;
  }
  if (rawMessage && typeof rawMessage === "object") {
    if (typeof rawMessage.message === "string") {
      return { ...rawMessage, message: sanitizeAgyToolErrorMessage(rawMessage.message) };
    }
    if (typeof rawMessage.error === "string") {
      return { ...rawMessage, error: sanitizeAgyToolErrorMessage(rawMessage.error) };
    }
  }
  return rawMessage;
}


/**
 * Find the most authoritative transcript file for an Antigravity conversation.
 * Checks for untruncated `transcript_full.jsonl` first, then falls back to `transcript.jsonl`.
 * Checks candidate directories across all possible Gemini homes (~/.gemini/antigravity-cli,
 * ~/.gemini/antigravity-ide, ~/.gemini/antigravity, ~/.gemini/brain, etc.).
 */
export function findTranscriptPath(conversationId: string, geminiHome?: string): string | undefined {
  const home = geminiHome || path.join(os.homedir(), ".gemini");
  const baseDirs = [
    path.join(home, "antigravity-cli", "brain", conversationId, ".system_generated", "logs"),
    path.join(home, "antigravity-ide", "brain", conversationId, ".system_generated", "logs"),
    path.join(home, "antigravity", "brain", conversationId, ".system_generated", "logs"),
    path.join(home, "brain", conversationId, ".system_generated", "logs"),
    path.join(os.homedir(), ".gemini", "antigravity-cli", "brain", conversationId, ".system_generated", "logs"),
    path.join(os.homedir(), ".gemini", "antigravity-ide", "brain", conversationId, ".system_generated", "logs"),
    path.join(os.homedir(), ".gemini", "antigravity", "brain", conversationId, ".system_generated", "logs"),
    path.join(os.homedir(), ".gemini", "brain", conversationId, ".system_generated", "logs"),
  ];
  // 1. Prefer transcript_full.jsonl (untruncated, not double-encoded)
  for (const dir of baseDirs) {
    const fullPath = path.join(dir, "transcript_full.jsonl");
    if (fs.existsSync(fullPath)) return fullPath;
  }
  // 2. Fallback to transcript.jsonl
  for (const dir of baseDirs) {
    const compactPath = path.join(dir, "transcript.jsonl");
    if (fs.existsSync(compactPath)) return compactPath;
  }
  return undefined;
}

/**
 * Look up the most recent tool call arguments for a given tool name and file path
 * from the conversation's transcript on disk.
 */
export function findRecentTranscriptToolCall(
  conversationId: string | undefined,
  geminiHome: string | undefined,
  toolName: string,
  filePath: string,
  cwd: string,
  stepIndex?: number,
): any | undefined {
  if (!conversationId) return undefined;
  const transcriptPath = findTranscriptPath(conversationId, geminiHome);
  if (!transcriptPath) return undefined;
  try {
    const content = fs.readFileSync(transcriptPath, "utf8");
    const lines = content.split(/\r?\n/).filter(Boolean);
    const targetKey = normalizeBaselineKey(filePath, cwd);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const step = JSON.parse(lines[i]);
        if (stepIndex != null) {
          // A tool call in the transcript corresponds to the current step if its step_index
          // matches the tool step or the immediately preceding planner step.
          if (step.step_index !== stepIndex && step.step_index !== stepIndex - 1) {
            continue;
          }
        }
        if (Array.isArray(step.tool_calls)) {
          for (const tc of step.tool_calls) {
            const name = tc.name ?? tc.tool_name ?? tc.toolName ?? tc.tool?.name;
            if (name === toolName) {
              const raw = unwrapTranscriptStrings(tc.args ?? tc.parameters ?? tc.params ?? {});
              const file = raw?.TargetFile || raw?.file_path || raw?.path;
              if (typeof file === "string" && normalizeBaselineKey(file, cwd) === targetKey) {
                return raw;
              }
            }
          }
        }
      } catch {}
    }
  } catch {}
  return undefined;
}

/**
 * Antigravity's persistent `transcript.jsonl` (read only by `replayToolCalls`,
 * never by the live `stream-json` path) stores each string-valued tool
 * argument JSON-stringified a SECOND time — a real capture showed
 * `"TargetContent":"\"**Revision:** 3.1 …\""`, whose value, once the whole
 * line is parsed, is the literal string `"**Revision:** 3.1 …"` (leading and
 * trailing quote characters included). Passing that straight to
 * `synthesizeEditDiff` would frame every replayed diff in stray quotes. This
 * unwraps every string field that looks double-encoded (JSON.parse succeeds
 * and yields a string); a field that doesn't decode cleanly is left as-is —
 * this is replay of an already-completed edit, so a decode miss can only
 * leave that one field's quoting slightly off, never invent a wrong diff.
 */
export function unwrapTranscriptStrings(params: any): any {
  if (!params || typeof params !== "object") return params;
  const out: any = Array.isArray(params) ? [] : {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") {
      try {
        const decoded = JSON.parse(value);
        out[key] = typeof decoded === "string" ? decoded : value;
      } catch {
        // If double-quoted by transcript.jsonl but inner quotes broke JSON.parse:
        if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
          out[key] = value.slice(1, -1);
        } else {
          out[key] = value;
        }
      }
    } else if (value && typeof value === "object") {
      out[key] = unwrapTranscriptStrings(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Build the `{ type: "diff" }` block for one of agy's edit tools from its raw
 * (un-normalized) parameters (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md § 4.1).
 *
 * `write_to_file` reports only the new content — `diskOldText` (read by the
 * caller in the ACTIVE branch, before the write lands) supplies the "before"
 * side; a genuine creation leaves it undefined and the diff renders as a pure
 * add. `replace_file_content` / `multi_replace_file_content` already carry
 * both sides in their parameters, so no disk read is needed for those.
 *
 * `sed_file`'s parameter shape has not been captured against a live `agy`
 * process, so it is deliberately left unmapped rather than guessed (plan
 * § Offene Fragen #4) — its tool card falls back to the plain parameter view.
 */
export function synthesizeAgyToolDiff(
  name: string,
  rawParams: any,
  opts: { diskOldText?: string } = {},
): AcpDiffBlock | undefined {
  const p = rawParams && typeof rawParams === "object" ? rawParams : {};
  switch (name) {
    case "write_to_file": {
      const file = p.TargetFile || p.file_path || p.path;
      if (typeof file !== "string" || !file) return undefined;
      const newText = typeof p.CodeContent === "string" ? p.CodeContent : "";
      return synthesizeEditDiff({ path: file, oldText: opts.diskOldText ?? "", newText });
    }
    case "replace_file_content": {
      const file = p.TargetFile || p.file_path || p.path;
      if (typeof file !== "string" || !file) return undefined;
      const oldText = typeof p.TargetContent === "string" ? p.TargetContent : "";
      const newText = typeof p.ReplacementContent === "string" ? p.ReplacementContent : "";
      const parsedStart = typeof p.StartLine === "number" ? p.StartLine : (typeof p.StartLine === "string" ? parseInt(p.StartLine, 10) : NaN);
      const startLine = Number.isInteger(parsedStart) && parsedStart >= 1 ? parsedStart : undefined;
      // A replacement that changes the line count shifts every line after it —
      // `new_line` is only trustworthy when the region is line-count-neutral.
      const lineCountNeutral =
        (oldText ? oldText.split(/\r?\n/).length : 0) === (newText ? newText.split(/\r?\n/).length : 0);
      return synthesizeEditDiff({
        path: file,
        oldText,
        newText,
        oldLine: startLine,
        ...(lineCountNeutral && startLine !== undefined ? { newLine: startLine } : {}),
      });
    }
    case "multi_replace_file_content": {
      const file = p.TargetFile || p.file_path || p.path;
      if (typeof file !== "string" || !file) return undefined;
      const chunks = Array.isArray(p.ReplacementChunks) ? p.ReplacementChunks : [];
      if (!chunks.length) return undefined;
      const details = chunks.map((chunk: any) => {
        const parsedLine = typeof chunk?.StartLine === "number" ? chunk.StartLine : (typeof chunk?.StartLine === "string" ? parseInt(chunk.StartLine, 10) : NaN);
        return {
          old_string: typeof chunk?.TargetContent === "string" ? chunk.TargetContent : "",
          new_string: typeof chunk?.ReplacementContent === "string" ? chunk.ReplacementContent : "",
          ...(Number.isInteger(parsedLine) && parsedLine >= 1 ? { old_line: parsedLine } : {}),
        };
      });
      const first = chunks[0] ?? {};
      // Block-level oldText/newText mirror the FIRST chunk only (matching
      // Grok's own replace_all echo) — the full account lives in details[].
      return synthesizeEditDiff({
        path: file,
        oldText: typeof first.TargetContent === "string" ? first.TargetContent : "",
        newText: typeof first.ReplacementContent === "string" ? first.ReplacementContent : "",
        details,
      });
    }
    default:
      return undefined;
  }
}

export function isImplementationPlanTool(name: string, params: any): boolean {
  if (!params || typeof params !== "object") return false;
  const target = String(params.TargetFile || params.AbsolutePath || params.file_path || params.path || "");
  if (/(?:^|[\\/])implementation_plan\.md$/i.test(target)) return true;
  if (params.ArtifactMetadata?.RequestFeedback === true && /\.md$/i.test(target)) return true;
  return false;
}

export function extractPlanText(params: any, cwd?: string): string {
  if (!params || typeof params !== "object") return "";
  if (typeof params.CodeContent === "string" && params.CodeContent.trim()) {
    return params.CodeContent;
  }
  if (typeof params.content === "string" && params.content.trim()) {
    return params.content;
  }
  if (typeof params.ReplacementContent === "string" && params.ReplacementContent.trim()) {
    return params.ReplacementContent;
  }
  const target = params.TargetFile || params.AbsolutePath || params.file_path || params.path;
  if (typeof target === "string" && target) {
    try {
      const resolved = path.isAbsolute(target) ? target : (cwd ? path.resolve(cwd, target) : path.resolve(target));
      if (fs.existsSync(resolved)) {
        return fs.readFileSync(resolved, "utf8");
      }
    } catch {}
  }
  return "";
}

export interface StoredSessionInfo {
  conversationId: string;
  cwd: string;
  title?: string;
  updatedAt: number;
}

export function cleanPromptTitle(text: string): string {
  if (!text) return "Antigravity Session";
  const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  const raw = stripAgyAdapterInstructions(m ? m[1] : text);
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/<[^>]+>/g, "").trim())
    .filter((l) => l.length > 0 && !l.startsWith("Currently open") && !l.startsWith("The current local time"));
  const first = lines[0]?.trim();
  return first ? (first.length > 80 ? `${first.slice(0, 77)}…` : first) : "Antigravity Session";
}

export function stripAgyAdapterInstructions(text: string): string {
  return text.replace(/^<companions_adapter_instructions>\n[\s\S]*?\n<\/companions_adapter_instructions>\n\n/, "");
}

export interface AgyAdapterOptions {
  modelDiscovery?: () => Promise<string>;
  agyPath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  defaultModelId?: string;
  defaultEffort?: string;
  defaultModeId?: string;
  printTimeout?: string;
  geminiHome?: string;
  /** Where the `acpSessionId -> conversation_id` map lives. Injected by tests. */
  conversationStorePath?: string;
  inputStream?: NodeJS.ReadableStream;
  outputStream?: NodeJS.WritableStream;
  spawnFn?: (command: string, args: string[], options: any) => ChildProcessWithoutNullStreams;
  supportsInputFormat?: boolean;
  processStopGraceMs?: number;
  processStopTimeoutMs?: number;
  toolRules?: "prompt" | "off" | "global";
  watchdogIdleTimeoutMs?: number;
  /** Overrides for `waitForDiskChangeText`'s retry loop. Production defaults
   *  to (50, 200) — a ~10s budget; tests inject a much smaller budget so the
   *  "the write never lands" cases don't each cost the full production wait. */
  diskPollAttempts?: number;
  diskPollDelayMs?: number;
}

/** Staged prompt images older than this are removed when an adapter starts. */
export const STAGED_IMAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const STAGED_IMAGE_NAME = /^image-[0-9a-f-]{36}\.(png|jpe?g|webp|gif)$/i;

/**
 * Remove images this adapter staged (`image-<uuid>.<ext>`) that are older than
 * `maxAgeMs`. A later turn may still ask agy to view an image from earlier in
 * the conversation, so a live session's files are never swept by turn; age is
 * the only safe signal across adapter lifetimes. Other files are left alone.
 */
export function sweepStaleStagedImages(dirs: readonly string[], now = Date.now(), maxAgeMs = STAGED_IMAGE_MAX_AGE_MS): string[] {
  const removed: string[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!STAGED_IMAGE_NAME.test(name)) continue;
      const file = path.join(dir, name);
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
        fs.rmSync(file, { force: true });
        removed.push(file);
      } catch {}
    }
  }
  return removed;
}

export interface PromptUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  totalTokens: number;
}

interface AgyTurn {
  id: number | string;
  text: string;
  state: AgyTurnState;
  abort: AbortController;
  usage: PromptUsage;
  tools: Map<string, "open" | "finishing" | "completed" | "failed">;
  visible: boolean;
  resolve: (result: any) => void;
  reject: (error: Error) => void;
  done: Promise<void>;
  finish: () => void;
  activityAt: number;
}

export class AgyAcpAdapterServer {
  private readonly agyPath: string;
  cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly spawnFn: (command: string, args: string[], options: any) => ChildProcessWithoutNullStreams;
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly printTimeout: string;
  private readonly geminiHome: string;
  private readonly diskPollAttempts: number;
  private readonly diskPollDelayMs: number;

  /** `write_to_file`'s pre-write disk read (ACTIVE branch), reused by the DONE
   *  branch so the "before" side is never read after the write has landed —
   *  by then disk already holds the "after" text. Cleared per toolCallId once
   *  the tool step resolves (completed OR error). */
  private readonly pendingWriteOldText = new Map<string, string | undefined>();

  /**
   * Session-lifetime "last known good" content per absolute file path.
   *
   * Live evidence (agy 1.1.26, live capture with the user): edits land on
   * disk essentially instantly — VS Code's own editor reflects the change
   * immediately — so the earlier "write is slow, poll for it" model was
   * diagnosing the wrong race. For a near-instant local write, ACTIVE and
   * DONE for the same tool step can both be emitted (and read from stdout)
   * AFTER the file already changed, which means the ACTIVE-phase disk read
   * in `synthesizeAgyDiffContent` is reading POST-write content too — old
   * and new end up identical ("+0 −0"), not because the write was slow but
   * because there was never a real "before" moment on the wire to read from.
   *
   * This map breaks that by not depending on ACTIVE's timing at all for any
   * file this session has already touched: the DONE branch of every edit
   * updates this cache with the resulting content, and the NEXT edit to that
   * same path (even in a later turn) uses this cached value as its "before"
   * instead of re-reading disk at ACTIVE. Only the very first edit to a given
   * path in a session still relies on the ACTIVE-time disk read (there is no
   * prior cached value yet), so it remains exposed to the same race.
   */
  private readonly sessionFileBaseline = new Map<string, string | undefined>();

  /** Edits whose write hadn't landed on disk by the end of their own DONE
   *  poll — rechecked once more at turn-end (flushPendingEditRechecks). */
  private pendingEditRecheck: Array<{ toolCallId: string; file: string; diskOldText: string | undefined }> = [];

  /**
   * In-flight `synthesizeAgyDiffContent` calls for the current turn. Live
   * evidence: the "result" event (turn complete) can arrive WHILE a DONE-phase
   * poll (up to ~3s) is still running, so `flushPendingEditRechecks` running
   * synchronously at that point finds nothing queued yet — the entry is only
   * pushed once the poll itself gives up. The "result" handler awaits all of
   * these before flushing/resolving, so no edit's diff correction is lost to
   * that race.
   */
  private pendingDiffPromises: Promise<unknown>[] = [];

  /** Images this adapter wrote into a staging directory for the current session. */
  private readonly stagedImages = new Set<string>();

  private rl?: Interface;
  private agyProc?: ChildProcessWithoutNullStreams;
  private agyRl?: Interface;
  private agyErrRl?: Interface;

  sessionId?: string;
  currentModelId: string;
  currentEffort: string;
  currentModeId: string;
  activeConversationId?: string;
  pendingExitPlanId?: number | string;

  /** A model/effort/mode change that arrived while a turn was running. Applying
   *  it means respawning `agy`, which throws away work already billed for — so
   *  the respawn waits until the next prompt. */
  private respawnBeforeNextPrompt = false;
  /** Where `acpSessionId -> conversation_id` is remembered across adapter
   *  lifetimes. Without it, reopening a conversation started a blank one the UI
   *  still showed a full history for, and every follow-up had to be re-explained. */
  private readonly conversationStorePath: string;

  private pendingPrompt?: AgyTurn;
  private readonly promptQueue: AgyTurn[] = [];
  private closing = false;
  private disposed = false;
  private stopPromise?: Promise<void>;
  private processBlocked = false;
  private readonly stopOptions: { graceMs: number; timeoutMs: number };
  private readonly toolRules: "prompt" | "off" | "global";
  private sessionTransition?: Promise<void>;
  private cancelGeneration = 0;
  private readonly replaySeen = new Set<string>();
  private skillCommands: AgySkillCommand[] = [];
  private readonly watchdogIdleTimeoutMs: number;
  private humanWaitActive = false;

  constructor(options: AgyAdapterOptions = {}) {
    this.agyPath = options.agyPath || process.env.AGY_PATH || process.env.GEMINI_CLI_EXECUTABLE || "agy";
    this.cwd = options.cwd || process.env.AGY_CWD || process.cwd();
    this.env = options.env || { ...process.env };
    this.currentModelId = options.defaultModelId || "gemini-3.8-flash";
    this.currentEffort = options.defaultEffort || "";
    this.currentModeId = options.defaultModeId || process.env.AGY_DEFAULT_MODE || "agent";
    this.geminiHome = options.geminiHome || path.join(os.homedir(), ".gemini");
    this.conversationStorePath = options.conversationStorePath
      || path.join(this.geminiHome, "grok-acp-conversations.json");
    this.printTimeout = options.printTimeout || options.env?.AGY_PRINT_TIMEOUT || process.env.AGY_PRINT_TIMEOUT || "24h";
    this.input = options.inputStream || process.stdin;
    this.output = options.outputStream || process.stdout;
    this.spawnFn = options.spawnFn || ((cmd, args, opts) => spawn(cmd, args, opts));
    this.stopOptions = { graceMs: options.processStopGraceMs ?? 1000, timeoutMs: options.processStopTimeoutMs ?? 3000 };
    this.toolRules = options.toolRules ?? (this.env.AGY_TOOL_RULES as "prompt" | "off" | "global" | undefined) ?? "prompt";
    if (!["prompt", "off", "global"].includes(this.toolRules)) throw new Error("Invalid Antigravity tool rule policy");
    this.watchdogIdleTimeoutMs = options.watchdogIdleTimeoutMs ?? Number(this.env.AGY_WATCHDOG_IDLE_TIMEOUT_MS || 0);
    if (!Number.isSafeInteger(this.watchdogIdleTimeoutMs) || (this.watchdogIdleTimeoutMs !== 0 && this.watchdogIdleTimeoutMs < 30000))
      throw new Error("Antigravity watchdog timeout must be 0 or at least 30000 milliseconds");
    // Fake long-lived processes must not cause real binary probes in unit tests.
    // Protocol-only cases leave spawnFn unset; under Vitest those must not launch
    // a real `agy models` either. A live CLI delays session/new past the reply
    // the suite waits for, and the suite is binary-free.
    const discoverLiveModels = !options.spawnFn && process.env.VITEST !== "true";
    this.modelDiscovery = options.modelDiscovery ?? (discoverLiveModels ? () => new Promise<string>((resolve, reject) => {
      const proc = this.spawnFn(shellSafeCommand(this.agyPath), ["models"], { cwd: this.cwd, env: this.env,
        stdio: ["pipe", "pipe", "pipe"], shell: grokCliNeedsShell(this.agyPath), windowsHide: true });
      let output = "";
      const timer = setTimeout(() => { proc.kill(); reject(new Error("Model discovery timed out")); }, 3000);
      timer.unref();
      proc.stdout.on("data", chunk => {
        output += chunk.toString();
        if (output.length > 1024 * 1024) { proc.kill(); clearTimeout(timer); reject(new Error("Model listing too large")); }
      });
      proc.on("error", error => { clearTimeout(timer); reject(error); });
      proc.on("close", code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error("Model discovery unavailable")); });
    }) : undefined);
    this.diskPollAttempts = options.diskPollAttempts ?? 50;
    this.diskPollDelayMs = options.diskPollDelayMs ?? 200;
    // A caller-supplied spawnFn means a test harness stands in for the real
    // CLI (production never overrides this) — skip the real `--help` probe
    // and assume the modern stream-json flag rather than spawning a real
    // `agy` process (or the test's own fake, which expects exactly one
    // spawn call: the actual prompt) behind the test's back.
    this.supportsInputFormatStreamJson = options.supportsInputFormat ?? (options.spawnFn ? true : undefined);
    if (this.toolRules === "global") ensureAntigravityToolRules(this.geminiHome);
  }

  private supportsInputFormatStreamJson?: boolean;
  private readonly effortRequirementOverrides = new Map<string, boolean>();
  private readonly lastStderrBuffer: string[] = [];
  private lastUsage: PromptUsage = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 };
  private discoveredModels?: AgyModelEntry[];
  private modelDiscovery?: () => Promise<string>;

  private async refreshAvailableModels(): Promise<void> {
    if (!this.modelDiscovery) return;
    try {
      const result = parseAgyModelsOutput(await this.modelDiscovery());
      if (result.availableModels.length) this.discoveredModels = result.availableModels;
    } catch { /* Offline/auth failure: retain last listing, with known fallbacks. */ }
  }

  /**
   * Async on purpose: a synchronous `spawnSync` here (even with `windowsHide:
   * true`) can still flash a console window on Windows when `agyPath` is a
   * `.cmd` shim, because `shell: true` + `spawnSync` races the hidden-window
   * flag in a way plain async `spawn` (used for the long-lived agy process
   * below) does not. Cached after the first call, so this only ever runs
   * once per adapter instance. Uses the real `spawn` rather than the
   * injectable `this.spawnFn` seam so it stays independent of whatever fake
   * process a test wires up for the long-lived agy process.
   */
  async probeSupportsInputFormat(): Promise<boolean> {
    if (this.supportsInputFormatStreamJson !== undefined) {
      return this.supportsInputFormatStreamJson;
    }
    try {
      const proc = spawn(shellSafeCommand(this.agyPath), ["--help"], {
        windowsHide: true,
        shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.agyPath),
      });
      const supportsFlag = await new Promise<boolean>((resolve) => {
        let out = "";
        // Matches the old spawnSync catch-all: an unreadable probe assumes
        // the newer, stream-json-capable CLI rather than falling back.
        const timer = setTimeout(() => {
          proc.kill();
          resolve(true);
        }, 5000);
        proc.stdout?.on("data", (chunk) => { out += chunk; });
        proc.stderr?.on("data", (chunk) => { out += chunk; });
        proc.on("error", () => {
          clearTimeout(timer);
          resolve(true);
        });
        proc.on("close", () => {
          clearTimeout(timer);
          resolve(out.includes("--input-format"));
        });
      });
      this.supportsInputFormatStreamJson = supportsFlag;
    } catch {
      this.supportsInputFormatStreamJson = true;
    }
    return this.supportsInputFormatStreamJson;
  }

  effectiveModelRequiresEffort(modelId: string): boolean {
    if (this.effortRequirementOverrides.has(modelId)) {
      return this.effortRequirementOverrides.get(modelId)!;
    }
    return this.discoveredModels?.find(model => model.modelId === modelId)?._meta.supportsReasoningEffort
      ?? modelRequiresEffort(modelId);
  }

  private effortOptions(): Array<{ value: string; name: string }> {
    const model = this.getAvailableModels().find(model => model.modelId === this.currentModelId);
    const values = model?._meta?.reasoningEfforts?.map((effort: { value: string }) => effort.value)
      ?? ["low", "medium", "high"];
    return values.map((value: string) => ({ value, name: value.charAt(0).toUpperCase() + value.slice(1) }));
  }

  private effectiveEffort(): string {
    const values = this.effortOptions().map(option => option.value);
    return values.includes(this.currentEffort) ? this.currentEffort
      : values.includes(DEFAULT_AGY_EFFORT) ? DEFAULT_AGY_EFFORT : values[0] || DEFAULT_AGY_EFFORT;
  }

  getAvailableModels(): any[] {
    const list: any[] = this.discoveredModels ? [...this.discoveredModels]
      : DEFAULT_GEMINI_MODELS.map(model => ({ ...model, _meta: { ...model._meta, contextQuality: "estimated" } }));
    if (this.currentModelId && !list.some((m) => m.modelId === this.currentModelId)) {
      list.unshift({
        modelId: this.currentModelId,
        name: `${this.currentModelId} (Custom)`,
        description: "Custom Antigravity model ID",
        _meta: {
          supportsReasoningEffort: this.effectiveModelRequiresEffort(this.currentModelId),
          reasoningEfforts: [{ value: "low" }, { value: "medium" }, { value: "high" }],
          totalContextTokens: contextWindowForModel(this.currentModelId),
        },
      });
    }
    return list;
  }

  start(): void {
    this.rl = createInterface({ input: this.input });
    this.rl.on("line", (line) => { void this.handleClientLine(line).catch(error => {
      process.stderr.write(`[agy] client request failed: ${(error as Error).message}\n`);
      this.dispose();
    }); });
    this.rl.on("error", () => this.dispose());
    this.input.on("error", () => this.dispose());
    this.output.on("error", () => this.dispose());
    this.input.on("end", () => this.dispose());
  }

  private shutdownPromise?: Promise<void>;

  async shutdown(): Promise<void> {
    this.dispose();
    await this.shutdownPromise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelGeneration++;
    this.closing = true;
    this.abortQueuedPrompts();
    this.shutdownPromise = this.cancelActiveTurn();
    this.rl?.close();
    this.rl = undefined;
    this.activeConversationId = undefined;
    this.pendingExitPlanId = undefined;
    this.pendingWriteOldText.clear();
    this.pendingEditRecheck = [];
    this.pendingDiffPromises = [];
  }

  /** The whole map, or an empty one. A store we cannot read is not an error
   *  worth failing a session over — it only costs one lost resume. */
  private readConversationStore(): Record<string, StoredSessionInfo> {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.conversationStorePath, "utf8"));
      if (!parsed || typeof parsed !== "object") return {};
      const result: Record<string, StoredSessionInfo> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") {
          const enriched = this.enrichSessionFromTranscript(v);
          result[k] = {
            conversationId: v,
            cwd: enriched?.cwd || this.cwd || "",
            title: enriched?.title || "Antigravity Session",
            updatedAt: enriched?.updatedAt || Date.now(),
          };
        } else if (v && typeof v === "object") {
          const item = v as any;
          result[k] = {
            conversationId: typeof item.conversationId === "string" ? item.conversationId : "",
            cwd: typeof item.cwd === "string" ? item.cwd : this.cwd || "",
            title: typeof item.title === "string" ? item.title : undefined,
            updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : Date.now(),
          };
        }
      }
      return result;
    } catch {
      return {};
    }
  }

  private writeConversationStore(store: Record<string, StoredSessionInfo>): void {
    try {
      fs.mkdirSync(path.dirname(this.conversationStorePath), { recursive: true });
      fs.writeFileSync(this.conversationStorePath, JSON.stringify(store, null, 2), "utf8");
    } catch {
      // Best effort: a resume we cannot remember is worse than one we cannot
      // write, and neither is worth ending the session for.
    }
  }

  rememberConversation(
    sessionId: string,
    conversationId: string,
    meta?: { cwd?: string; title?: string; updatedAt?: number },
  ): void {
    const store = this.readConversationStore();
    const existing = store[sessionId];
    store[sessionId] = {
      conversationId: conversationId || existing?.conversationId || "",
      cwd: meta?.cwd || existing?.cwd || this.cwd || "",
      title: meta?.title || existing?.title,
      updatedAt: meta?.updatedAt || existing?.updatedAt || Date.now(),
    };
    this.writeConversationStore(store);
  }

  private forgetConversation(sessionId: string): void {
    const store = this.readConversationStore();
    if (!(sessionId in store)) return;
    delete store[sessionId];
    this.writeConversationStore(store);
  }

  lookupConversation(sessionId: string): string | undefined {
    const store = this.readConversationStore();
    const found = store[sessionId];
    if (found?.conversationId) return found.conversationId;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) {
      return sessionId;
    }
    return undefined;
  }

  private enrichSessionFromTranscript(conversationId: string): { title?: string; cwd?: string; updatedAt?: number } | undefined {
    const transcriptPath = findTranscriptPath(conversationId, this.geminiHome);
    if (!transcriptPath) return undefined;
    try {
      const stat = fs.statSync(transcriptPath);
      const lines = fs.readFileSync(transcriptPath, "utf8").split(/\r?\n/).filter(Boolean);
      let title: string | undefined;
      let cwd: string | undefined;
      for (const line of lines) {
        try {
          const s = JSON.parse(line);
          if (!title && s.type === "USER_INPUT" && typeof s.content === "string") {
            title = cleanPromptTitle(s.content);
          }
          if (!cwd && s.tool_calls && Array.isArray(s.tool_calls)) {
            for (const tc of s.tool_calls) {
              const c = tc.args?.Cwd || tc.args?.SearchPath || tc.args?.AbsolutePath || tc.args?.TargetFile;
              if (typeof c === "string") {
                const cleaned = c.replace(/^["']+|["']+$/g, "").replace(/\\\\/g, "\\");
                if (cleaned.includes(":") || cleaned.startsWith("/")) {
                  try {
                    cwd = fs.existsSync(cleaned) && fs.statSync(cleaned).isDirectory() ? cleaned : path.dirname(cleaned);
                  } catch {
                    cwd = path.dirname(cleaned);
                  }
                  break;
                }
              }
            }
          }
          if (title && cwd) break;
        } catch {}
      }
      return { title, cwd, updatedAt: stat.mtimeMs };
    } catch {
      return undefined;
    }
  }

  private readNativeAntigravitySessions(targetCwd?: string): any[] {
    const candidates = [
      path.join(this.geminiHome, "antigravity-cli", "conversation_summaries.db"),
      path.join(this.geminiHome, "antigravity", "conversation_summaries.db"),
      path.join(os.homedir(), ".gemini", "antigravity-cli", "conversation_summaries.db"),
      path.join(os.homedir(), ".gemini", "antigravity", "conversation_summaries.db"),
    ];
    const dbPath = candidates.find((p) => fs.existsSync(p));
    if (!dbPath) return [];

    try {
      // Use dynamic require so environments without node:sqlite don't crash
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const query = "SELECT conversation_id, title, workspace_uris, last_modified_time FROM conversation_summaries ORDER BY last_modified_time DESC LIMIT 100";
      const rows = db.prepare(query).all() as Array<{
        conversation_id: string;
        title: string;
        workspace_uris: string;
        last_modified_time: string;
      }>;
      db.close();

      const normalizeKey = (p: string) => {
        const resolved = path.resolve(p);
        return process.platform === "win32" ? resolved.toLowerCase() : resolved;
      };
      const targetKey = targetCwd ? normalizeKey(targetCwd) : undefined;
      const results: any[] = [];

      for (const row of rows) {
        if (!row.conversation_id) continue;
        let uris: string[] = [];
        try {
          if (row.workspace_uris) uris = JSON.parse(row.workspace_uris);
        } catch {}

        let matchedCwd = "";
        if (Array.isArray(uris) && uris.length > 0) {
          for (const rawUri of uris) {
            let localPath = rawUri.replace(/^file:\/\//i, "");
            if (/^\/[a-zA-Z]:[/\\]/.test(localPath)) localPath = localPath.slice(1);
            try { localPath = decodeURIComponent(localPath); } catch {}
            const norm = normalizeKey(localPath);
            if (!targetKey || norm === targetKey || targetKey.startsWith(norm) || norm.startsWith(targetKey)) {
              matchedCwd = targetCwd || localPath;
              break;
            }
          }
        }
        if (targetKey && !matchedCwd) continue;

        const updatedAt = row.last_modified_time ? Date.parse(row.last_modified_time) || Date.now() : Date.now();
        results.push({
          sessionId: row.conversation_id,
          cwd: matchedCwd || targetCwd || this.cwd,
          title: row.title?.trim() || "Antigravity Session",
          updatedAt,
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  listStoredSessions(targetCwd?: string): any[] {
    const store = this.readConversationStore();
    const result: any[] = [];
    const seenSessionIds = new Set<string>();
    const seenConversationIds = new Set<string>();

    const normalizeKey = (p: string) => {
      const resolved = path.resolve(p);
      return process.platform === "win32" ? resolved.toLowerCase() : resolved;
    };
    const targetKey = targetCwd ? normalizeKey(targetCwd) : undefined;

    // 1. Sessions stored via ACP
    for (const [sessionId, info] of Object.entries(store)) {
      if (!info) continue;
      if (!info.conversationId && (!info.title || info.title === "New session")) continue;
      const sessionCwd = info.cwd || this.cwd;
      if (targetKey && sessionCwd) {
        const norm = normalizeKey(sessionCwd);
        if (norm !== targetKey && !targetKey.startsWith(norm) && !norm.startsWith(targetKey)) {
          continue;
        }
      }
      seenSessionIds.add(sessionId);
      if (info.conversationId) seenConversationIds.add(info.conversationId);
      result.push({
        sessionId,
        cwd: targetCwd || sessionCwd,
        title: info.title || "Antigravity Session",
        updatedAt: info.updatedAt || Date.now(),
      });
    }

    // 2. Native Antigravity sessions from SQLite
    try {
      const nativeSessions = this.readNativeAntigravitySessions(targetCwd);
      for (const entry of nativeSessions) {
        if (!seenSessionIds.has(entry.sessionId) && !seenConversationIds.has(entry.sessionId)) {
          seenSessionIds.add(entry.sessionId);
          result.push(entry);
        }
      }
    } catch {}

    result.sort((a, b) => {
      const aTime = typeof a.updatedAt === "number" ? a.updatedAt : Date.parse(a.updatedAt) || 0;
      const bTime = typeof b.updatedAt === "number" ? b.updatedAt : Date.parse(b.updatedAt) || 0;
      return bTime - aTime;
    });

    return result;
  }

  replayTranscript(conversationId: string): void {
    const transcriptPath = findTranscriptPath(conversationId, this.geminiHome);
    if (!transcriptPath) return;

    const touchedFiles = new Set<string>();
    try {
      const content = fs.readFileSync(transcriptPath, "utf8");
      const lines = content.split(/\r?\n/);
      for (const [index, line] of lines.entries()) {
        try {
          const step = JSON.parse(line);
          const key = `${conversationId}:${index}:${createHash("sha256").update(line).digest("hex")}`;
          if (this.replaySeen.has(key)) continue;
          this.replaySeen.add(key);
          if (step.type === "USER_INPUT" && typeof step.content === "string") {
            const m = step.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            const userText = stripAgyAdapterInstructions(m ? m[1].trim() : step.content.trim());
            if (userText) {
              this.sendNotification("session/update", {
                sessionId: this.sessionId,
                update: {
                  sessionUpdate: "user_message_chunk",
                  content: { type: "text", text: userText },
                },
              });
            }
          } else if (step.type === "PLANNER_RESPONSE" && typeof step.content === "string" && step.content.trim()) {
            this.sendNotification("session/update", {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: step.content },
              },
            });
          }
          this.replayToolCalls(step, key, touchedFiles);
        } catch {}
      }

      // Seed sessionFileBaseline with the current on-disk content of all files touched in the replayed transcript.
      // Without this, the very first edit after a session reload has no cached baseline, falling back to an
      // ACTIVE-phase disk read that races against near-instant local writes (causing "+0 −0").
      for (const file of touchedFiles) {
        const currentDisk = this.readDiskTextForDiff(file);
        if (currentDisk !== undefined) {
          const key = normalizeBaselineKey(file, this.cwd);
          this.sessionFileBaseline.set(key, currentDisk);
        }
      }
    } catch {}
  }

  /**
   * Best-effort tool-call replay (docs/UNIVERSAL_DIFF_SUPPORT_PLAN.md § 4.6,
   * PR 4). Without Viewing on replay, every Antigravity edit made in a past
   * turn goes invisible the moment the conversation is reopened — the same
   * regression `applyToolDiffs` running on both `tool_call` and
   * `tool_call_update` was built to prevent for the live path (#30).
   *
   * `step.tool_calls[].args` is the one field this adapter already reads from
   * a live transcript ({@link enrichSessionFromTranscript}'s cwd inference),
   * so it is trustworthy. The tool NAME field is not independently confirmed
   * against a real `agy` transcript — every plausible key is tried, and a
   * step whose shape doesn't match any of them is skipped rather than guessed
   * at, so a wrong assumption here can only leave a tool unreplayed (today's
   * baseline), never render something incorrect.
   */
  private replayToolCalls(step: any, recordId: string, touchedFiles?: Set<string>): void {
    const calls = Array.isArray(step?.tool_calls) ? step.tool_calls : [];
    for (const [index, tc] of calls.entries()) {
      if (!tc || typeof tc !== "object") continue;
      const name = tc.name ?? tc.tool_name ?? tc.toolName ?? tc.tool?.name;
      if (typeof name !== "string" || !name) continue;
      const rawParams = unwrapTranscriptStrings(tc.args ?? tc.parameters ?? tc.params ?? {});
      const params = normalizeToolInput(name, rawParams);
      if (touchedFiles && (name === "write_to_file" || name === "replace_file_content" || name === "multi_replace_file_content")) {
        const f = rawParams?.TargetFile || rawParams?.file_path || rawParams?.path;
        if (typeof f === "string" && f) touchedFiles.add(f);
      }
      const toolCallId = `replay-${recordId}:${index}`;
      const content = mergeDiffIntoContent(undefined, synthesizeAgyToolDiff(name, rawParams));
      this.sendNotification("session/update", {
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolTitle(name, params),
          kind: toolKind(name),
          status: "completed",
          rawInput: params,
          ...(content.length ? { content } : {}),
        },
      });
    }
  }

  /** A config change needs a fresh `agy` with new flags. Mid-turn that would
   *  discard tokens the user has already paid for, so it waits. */
  private requestRespawn(): void {
    if (this.pendingPrompt) {
      this.respawnBeforeNextPrompt = true;
      return;
    }
    void this.killAgyProc().catch(() => {});
  }

  /** Stop actually stops. ACP delivers `session/cancel` as a notification, and
   *  before this the adapter dropped it — `agy` ran the turn to completion (up
   *  to `--print-timeout`) while nothing was listening, and billed for it. */
  private async cancelActiveTurn(): Promise<void> {
    this.humanWaitActive = false;
    const turn = this.pendingPrompt;
    if (turn) {
      turn.state = "cancelling";
      turn.abort.abort();
    }
    try { await this.killAgyProc(); } catch { /* runTurn reports the blocked process */ }
    if (turn) await turn.done;
  }

  private killAgyProc(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.pendingExitPlanId = undefined;
    if (this.agyRl) {
      this.agyRl.close();
      this.agyRl = undefined;
    }
    if (this.agyErrRl) {
      this.agyErrRl.close();
      this.agyErrRl = undefined;
    }
    const proc = this.agyProc;
    if (!proc) return Promise.resolve();
    this.stopPromise = stopAgyProcess(proc, this.stopOptions).then(() => {
      if (this.agyProc === proc) this.agyProc = undefined;
    }, error => {
      this.processBlocked = true;
      throw error;
    }).finally(() => { this.stopPromise = undefined; });
    return this.stopPromise;
  }

  private abortQueuedPrompts(): void {
    for (const turn of this.promptQueue.splice(0)) {
      turn.abort.abort();
      turn.state = "terminal";
      this.sendResponse(turn.id, { stopReason: "cancelled", usage: turn.usage });
      turn.finish();
    }
  }

  private async resetSession(): Promise<void> {
    this.closing = true;
    this.abortQueuedPrompts();
    await this.cancelActiveTurn();
    this.sessionFileBaseline.clear();
    this.replaySeen.clear();
    this.pendingWriteOldText.clear();
    this.pendingEditRecheck = [];
    this.pendingDiffPromises = [];
    this.closing = false;
  }

  writeJsonRpc(message: any): void {
    const text = JSON.stringify(message) + "\n";
    this.output.write(text);
  }

  private sendResponse(id: number | string | undefined, result: any): void {
    if (id == null) return;
    this.writeJsonRpc({ jsonrpc: "2.0", id, result });
  }

  private sendError(id: number | string | undefined, code: number, message: string): void {
    if (id == null) return;
    this.writeJsonRpc({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private sendNotification(method: string, params: any): void {
    this.writeJsonRpc({ jsonrpc: "2.0", method, params });
  }

  getConfigOptions(): any[] {
    const modelOptions = this.getAvailableModels().map((m) => ({
      value: m.modelId,
      name: m.name,
      description: m.description,
    }));
    if (this.currentModelId && !modelOptions.some((m) => m.value === this.currentModelId)) {
      modelOptions.unshift({
        value: this.currentModelId,
        name: `${this.currentModelId} (Custom)`,
        description: "Custom Antigravity model ID",
      });
    }
    return [
      {
        id: "model",
        currentValue: this.currentModelId,
        options: modelOptions,
      },
      {
        id: "reasoning_effort",
        // The effective level, never "default" — for the models this option is
        // shown on, an absent level is not a state the CLI will start in.
        currentValue: this.effectiveModelRequiresEffort(this.currentModelId)
          ? this.effectiveEffort()
          : "default",
        options: this.effortOptions(),
      },
      {
        id: "mode",
        currentValue: this.currentModeId,
        options: [
          { value: "agent", name: "Agent" },
          { value: "yolo", name: "Auto accept" },
          { value: "plan", name: "Plan" },
        ],
      },
    ];
  }

  stagePromptImage(
    data: string,
    mimeType = "image/png",
    knownPath?: string,
  ): string {
    if (knownPath && typeof knownPath === "string") {
      try {
        if (fs.existsSync(knownPath) && fs.statSync(knownPath).isFile()) {
          return knownPath;
        }
      } catch {}
    }
    const ext = mimeType.includes("jpeg") || mimeType.includes("jpg")
      ? ".jpg"
      : mimeType.includes("webp")
        ? ".webp"
        : mimeType.includes("gif")
          ? ".gif"
          : ".png";
    const [stagingDir, fallbackDir] = this.stagingDirs();
    try {
      fs.mkdirSync(stagingDir, { recursive: true });
      const filePath = path.join(stagingDir, `image-${randomUUID()}${ext}`);
      fs.writeFileSync(filePath, Buffer.from(data, "base64"));
      this.stagedImages.add(filePath);
      return filePath;
    } catch {
      fs.mkdirSync(fallbackDir, { recursive: true });
      const filePath = path.join(fallbackDir, `image-${randomUUID()}${ext}`);
      fs.writeFileSync(filePath, Buffer.from(data, "base64"));
      this.stagedImages.add(filePath);
      return filePath;
    }
  }

  /** Where prompt images are staged: under the Gemini home, else the temp dir. */
  stagingDirs(): [string, string] {
    return [path.join(this.geminiHome, "staging"), path.join(os.tmpdir(), "gemini-staging")];
  }

  /** Delete the images this session staged; used when the session is deleted. */
  discardStagedImages(): void {
    for (const file of this.stagedImages) {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    }
    this.stagedImages.clear();
  }

  /** Remove staged images left behind by earlier adapter runs. */
  sweepStagedImages(now = Date.now()): string[] {
    return sweepStaleStagedImages(this.stagingDirs(), now);
  }

  processPromptBlocks(promptBlocks: any[], fallbackText?: string): string {
    let promptText = "";
    const imageInstructions: string[] = [];
    let imageCounter = 0;

    for (const block of promptBlocks) {
      if (typeof block === "string") {
        promptText += (promptText ? "\n" : "") + block;
      } else if (block && typeof block.text === "string") {
        promptText += (promptText ? "\n" : "") + block.text;
      } else if (block && block.type === "image") {
        imageCounter++;
        const data = typeof block.data === "string" ? block.data : "";
        const mimeType = typeof block.mimeType === "string" ? block.mimeType : "image/png";
        const knownPath = typeof block.path === "string" ? block.path : undefined;
        if (data || knownPath) {
          const imagePath = this.stagePromptImage(data, mimeType, knownPath);
          imageInstructions.push(
            `[Attached Image #${imageCounter}: Local file located at "${imagePath}". Please use the view_file tool on this path to inspect the image content.]`,
          );
        }
      }
    }
    if (!promptText && typeof fallbackText === "string") {
      promptText = fallbackText;
    }

    // Clean up contradictory hints meant for other CLIs so Antigravity isn't confused:
    promptText = promptText
      .replace(/\s*—\s*local staged copy;\s*thumbnail only;\s*do not access this path/gi, "")
      .replace(/\s*—\s*attached inline;\s*act on the path if needed,\s*but do not Read it/gi, "")
      .replace(/\s*\(attached inline\s*—\s*already visible to you;\s*do not read it from disk\)/gi, "");

    if (imageInstructions.length > 0) {
      promptText = (promptText ? promptText + "\n\n" : "") + imageInstructions.join("\n");
    }
    return promptText;
  }

  async handleClientLine(line: string): Promise<void> {
    if (this.disposed) return;
    let request: any;
    try { request = JSON.parse(line); } catch { return; }
    if (["session/new", "session/load", "session/delete"].includes(request.method)) {
      this.cancelGeneration++;
      this.closing = true;
      const transition = (this.sessionTransition ?? Promise.resolve()).then(() => this.handleClientRequest(line));
      this.sessionTransition = transition;
      try { await transition; } finally {
        if (this.sessionTransition === transition) {
          this.sessionTransition = undefined;
          this.closing = false;
          this.drainPromptQueue();
        }
      }
      return;
    }
    if (request.method === "session/cancel") this.cancelGeneration++;
    if (request.method === "session/prompt" && this.sessionTransition) {
      const generation = this.cancelGeneration;
      await this.sessionTransition;
      if (generation !== this.cancelGeneration) {
        this.sendResponse(request.id, { stopReason: "cancelled" });
        return;
      }
    }
    await this.handleClientRequest(line);
  }

  private async handleClientRequest(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: any;
    try {
      req = JSON.parse(trimmed);
    } catch {
      return;
    }
    const { id, method, params } = req;

    // Handle response to a pending exit_plan_mode request
    if (id != null && this.pendingExitPlanId != null && id === this.pendingExitPlanId) {
      this.pendingExitPlanId = undefined;
      const outcome = req.result?.outcome;
      if (outcome === "approved") {
        this.currentModeId = "agent";
        this.sendNotification("session/update", {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "current_mode_update",
            currentModeId: "agent",
          },
        });
        if (this.agyProc) {
          this.requestRespawn();
        }
      }
      return;
    }

    if (!method) return;
    if (this.sessionId && params?.sessionId && params.sessionId !== this.sessionId
      && ["session/prompt", "session/cancel", "session/set_mode", "session/set_config_option"].includes(method)) {
      this.sendError(id, -32602, "Request belongs to another Antigravity session");
      return;
    }

    switch (method) {
      case "initialize": {
        this.sendResponse(id, AGY_INITIALIZE_RESULT);
        break;
      }

      case "session/new": {
        await this.resetSession();
        await this.refreshAvailableModels();
        if (this.disposed) return;
        this.pendingExitPlanId = undefined;
        if (this.toolRules === "global") ensureAntigravityToolRules(this.geminiHome);
        if (typeof params?.cwd === "string" && params.cwd) {
          this.cwd = params.cwd;
        }
        this.activeConversationId = undefined;
        this.sessionId = randomUUID();
        this.publishSkillCommands();
        this.sendResponse(id, {
          sessionId: this.sessionId,
          models: {
            currentModelId: this.currentModelId,
            availableModels: this.getAvailableModels(),
          },
          configOptions: this.getConfigOptions(),
        });
        break;
      }

      case "session/load": {
        await this.resetSession();
        await this.refreshAvailableModels();
        if (this.disposed) return;
        this.pendingExitPlanId = undefined;
        if (typeof params?.cwd === "string" && params.cwd) {
          this.cwd = params.cwd;
        }
        const loadedSessionId = typeof params?.sessionId === "string" ? params.sessionId : randomUUID();
        this.sessionId = loadedSessionId;
        this.publishSkillCommands();
        // Isolation is per SESSION, not "always start over": the conversation
        // this session owns is resumed, anyone else's is not.
        this.activeConversationId = this.lookupConversation(loadedSessionId);
        if (this.activeConversationId) {
          this.replayTranscript(this.activeConversationId);
        }
        this.sendResponse(id, {
          sessionId: this.sessionId,
          models: {
            currentModelId: this.currentModelId,
            availableModels: this.getAvailableModels(),
          },
          configOptions: this.getConfigOptions(),
        });
        break;
      }

      case "session/set_config_option": {
        const configId = params?.configId;
        const value = params?.value;
        if (configId === "model" && typeof value === "string") {
          const prevModel = this.currentModelId;
          this.currentModelId = value;
          if (prevModel !== value && this.agyProc) {
            this.requestRespawn();
          }
        } else if ((configId === "reasoning_effort" || configId === "effort") && typeof value === "string") {
          const prevEffort = this.currentEffort;
          this.currentEffort = value === "default" ? "" : value;
          if (prevEffort !== this.currentEffort && this.agyProc) {
            this.requestRespawn();
          }
        } else if (configId === "mode" && typeof value === "string") {
          const prevMode = this.currentModeId;
          this.currentModeId = agyCliMode(value);
          if (prevMode !== this.currentModeId && this.agyProc) {
            this.requestRespawn();
          }
        }
        this.sendResponse(id, {
          configOptions: this.getConfigOptions(),
        });
        break;
      }

      case "session/set_mode": {
        const rawModeId = typeof params?.modeId === "string" ? params.modeId : "agent";
        const modeId = agyCliMode(rawModeId);
        const prevMode = this.currentModeId;
        this.currentModeId = modeId;
        if (prevMode !== modeId && this.agyProc) {
          this.requestRespawn();
        }
        this.sendResponse(id, {
          modes: {
            currentModeId: this.currentModeId,
          },
        });
        break;
      }

      case "session/prompt": {
        const promptBlocks = Array.isArray(params?.prompt) ? params.prompt : [];
        const promptText = this.processPromptBlocks(promptBlocks, params?.text);

        if (this.sessionId) {
          const cleanTitle = cleanPromptTitle(promptText);
          const store = this.readConversationStore();
          const existing = store[this.sessionId];
          if (existing) {
            if (!existing.title || existing.title === "Antigravity Session") {
              existing.title = cleanTitle;
            }
            existing.updatedAt = Date.now();
            if (this.cwd) existing.cwd = this.cwd;
            this.writeConversationStore(store);
          } else {
            store[this.sessionId] = {
              conversationId: this.activeConversationId || "",
              cwd: this.cwd || "",
              title: cleanTitle,
              updatedAt: Date.now(),
            };
            this.writeConversationStore(store);
          }
        }

        if (promptText.trim() === "/compact") {
          this.sendNotification("session/update", {
            sessionId: this.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Antigravity automatically manages and compacts context in the background. No manual compaction is needed.",
              },
            },
          });
          this.sendResponse(id, {
            stopReason: "end_turn",
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
          });
          break;
        }

        if (this.closing || this.processBlocked) {
          this.sendError(id, -32603, "Antigravity session is closing or process restart is blocked");
          break;
        }
        await this.executePrompt(id, promptText);
        break;
      }

      case "session/cancel": {
        this.pendingExitPlanId = undefined;
        await this.cancelActiveTurn();
        this.sendResponse(id, {});
        break;
      }

      case "_companions/human_wait": {
        if (params?.sessionId === this.sessionId) {
          this.humanWaitActive = params.active === true;
          if (this.pendingPrompt) this.pendingPrompt.activityAt = Date.now();
        }
        this.sendResponse(id, {});
        break;
      }

      case "session/delete": {
        const target = typeof params?.sessionId === "string" ? params.sessionId : this.sessionId;
        if (target) this.forgetConversation(target);
        if (!target || target === this.sessionId) {
          await this.resetSession();
          this.activeConversationId = undefined;
          this.sessionId = undefined;
          this.discardStagedImages();
        }
        this.sendResponse(id, {});
        break;
      }

      case "session/list": {
        const targetCwd = typeof params?.cwd === "string" && params.cwd ? params.cwd : this.cwd;
        const sessions = this.listStoredSessions(targetCwd);
        this.sendResponse(id, { sessions });
        break;
      }

      case "_x.ai/interject":
      case "x.ai/interject": {
        const text = typeof params?.text === "string" ? params.text : "";
        if (text && this.agyProc && !this.agyProc.killed) {
          try {
            const payload = JSON.stringify({
              event: "user",
              message: {
                role: "user",
                content: text,
              },
            }) + "\n";
            this.agyProc.stdin.write(payload);
          } catch {}
        }
        this.sendResponse(id, {});
        break;
      }

      case "_x.ai/mcp/list":
      case "x.ai/mcp/list": {
        const servers: any[] = [];
        const candidateFiles = [
          path.join(this.geminiHome, "antigravity-cli", "settings.json"),
          path.join(this.geminiHome, "settings.json"),
          ...antigravitySettingsPaths(this.geminiHome, this.env),
        ];
        for (const file of candidateFiles) {
          try {
            if (fs.existsSync(file)) {
              const raw = fs.readFileSync(file, "utf8");
              const parsed = JSON.parse(raw);
              const mcpServers = parsed?.mcpServers || parsed?.mcp_servers;
              if (mcpServers && typeof mcpServers === "object") {
                for (const [name, cfg] of Object.entries(mcpServers)) {
                  const s = cfg as any;
                  servers.push({
                    name,
                    displayName: s?.displayName || name,
                    enabled: s?.enabled !== false,
                    command: s?.command,
                    args: s?.args,
                    url: s?.url,
                    type: s?.type || (s?.url ? "sse" : "stdio"),
                    scope: "user",
                    scopeName: "Antigravity CLI",
                    configFile: path.basename(file),
                  });
                }
                break;
              }
            }
          } catch {}
        }
        this.sendResponse(id, { servers });
        break;
      }

      case "_x.ai/session/info":
      case "x.ai/session/info": {
        // stream-json usage is not an active-context snapshot.
        this.sendError(id, -32601, "Antigravity does not expose a verified session context snapshot");
        break;
      }

      default: {
        if (id != null) {
          this.sendError(id, -32601, `Method not found: ${method}`);
        }
        break;
      }
    }
  }

  /** The file's current content for diff synthesis, or undefined when it
   *  can't be read (doesn't exist yet, too big, or unreadable) — a genuine
   *  creation or a size we won't hold twice in memory. */
  private readDiskTextForDiff(rawPath: string): string | undefined {
    try {
      const abs = path.isAbsolute(rawPath) ? path.normalize(rawPath) : path.normalize(path.resolve(this.cwd, rawPath));
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > MAX_DIFF_EXPAND_BYTES) return undefined;
      return fs.readFileSync(abs, "utf8");
    } catch {
      return undefined;
    }
  }

  /**
   * Poll for the file's content to actually change from `before`.
   *
   * Live evidence (agy 1.1.26): the `DONE` step notification for
   * `replace_file_content` can arrive with the write not yet applied on
   * disk — confirmed via `mtime`/content comparisons taken right at `ACTIVE`
   * and right at `DONE`. Chasing this with an ever-longer poll has a hard
   * ceiling: a separate live capture showed the write still not landed even
   * ~10s after the ENTIRE multi-turn-second reasoning turn had been reported
   * complete by agy, confirmed later by `git diff` outside this extension —
   * agy's own write can lag its own completion signal by an effectively
   * unbounded amount, not just a race to close. This poll (bounded to ~10s)
   * catches the common case; the residual — a stale "+0 −0" card until the
   * conversation is reloaded — is a known limitation (see
   * docs/ANTIGRAVITY_INTEGRATION_COMPLETE_DOCUMENTATION.md § 9.4). Reload
   * replays from `transcript.jsonl` via `synthesizeAgyToolDiff` +
   * `unwrapTranscriptStrings`, which does carry the real before/after text.
   */
  private async waitForDiskChangeText(file: string, before: string | undefined, turn?: AgyTurn): Promise<string | undefined> {
    for (let i = 0; i < this.diskPollAttempts; i++) {
      if (turn?.abort.signal.aborted || (turn && this.pendingPrompt !== turn)) return undefined;
      const text = this.readDiskTextForDiff(file);
      if (text !== before) return text;
      await new Promise((resolve) => setTimeout(resolve, this.diskPollDelayMs));
    }
    return this.readDiskTextForDiff(file);
  }

  /**
   * `content` for an agy edit tool's session/update, or undefined when the
   * tool isn't an edit / carries no resolvable diff.
   *
   * When available, authoritative tool parameters are read from the active
   * conversation's persistent transcript (`transcript_full.jsonl`), avoiding
   * disk-write timing races entirely. When the transcript entry is not yet
   * present or not found, synthesis falls back to disk reads.
   *
   * ACTIVE reads disk (before the write) or uses the session baseline; DONE
   * reads disk again (after the write has landed) for the "after" side and
   * updates the session baseline cache.
   */
  private async synthesizeAgyDiffContent(
    toolCallId: string,
    name: string,
    rawParams: any,
    phase: "active" | "done" | "error",
    stepIndex?: number,
    turn?: AgyTurn,
  ): Promise<unknown[] | undefined> {
    if (name !== "write_to_file" && name !== "replace_file_content" && name !== "multi_replace_file_content") {
      return undefined;
    }
    const file = rawParams?.TargetFile || rawParams?.file_path || rawParams?.path;
    if (typeof file !== "string" || !file) return undefined;
    const baselineKey = normalizeBaselineKey(file, this.cwd);
    if (phase === "active") {
      // Prefer the session-lifetime baseline over a fresh disk read: for any
      // path already touched this session, a live read here can already be
      // reading the CURRENT edit's result (see sessionFileBaseline's doc) —
      // the cached value from the previous edit's DONE is the only reliable
      // "before" left. Only a path never seen this session falls back to a
      // live read, which is still exposed to the same race.
      const before = this.sessionFileBaseline.has(baselineKey)
        ? this.sessionFileBaseline.get(baselineKey)
        : this.readDiskTextForDiff(file);
      this.pendingWriteOldText.set(toolCallId, before);
      return undefined; // nothing to diff yet — the write hasn't landed
    }
    const diskOldText = this.pendingWriteOldText.get(toolCallId);
    this.pendingWriteOldText.delete(toolCallId);
    if (phase === "error") return undefined;

    // First check if authoritative tool parameters are recorded in the active transcript on disk.
    // If transcript_full.jsonl contains the tool call, it carries exact TargetContent/ReplacementContent,
    // avoiding disk timing races entirely.
    let diffFromTranscript: AcpDiffBlock | undefined;
    const transcriptArgs = findRecentTranscriptToolCall(this.activeConversationId, this.geminiHome, name, file, this.cwd, stepIndex);
    if (transcriptArgs) {
      diffFromTranscript = synthesizeAgyToolDiff(name, transcriptArgs, { diskOldText });
    }

    const diskNewText = await this.waitForDiskChangeText(file, diskOldText, turn);
    if (turn && (turn.abort.signal.aborted || this.pendingPrompt !== turn)) return undefined;
    this.sessionFileBaseline.set(baselineKey, diskNewText);

    if (diffFromTranscript) {
      return mergeDiffIntoContent(undefined, diffFromTranscript);
    }

    if (diskOldText === undefined && diskNewText === undefined) return undefined;
    if (diskOldText === diskNewText) {
      // Live evidence: some edits don't land on disk even within
      // waitForDiskChangeText's several-second budget — the write can be
      // deferred until the whole turn finishes, not just this tool step
      // (observed: the "turn complete" line logged before this poll gave
      // up). Queue it for one more check at turn-end (flushPendingEditRechecks).
      this.pendingEditRecheck.push({ toolCallId, file, diskOldText });
    }
    return mergeDiffIntoContent(
      undefined,
      synthesizeEditDiff({ path: file, oldText: diskOldText ?? "", newText: diskNewText ?? "" }),
    );
  }

  /**
   * Re-reads disk once more for every edit whose write hadn't landed by the
   * time its own DONE-phase poll gave up, and sends a corrective
   * `tool_call_update` (same `toolCallId`) if it has landed by now. Called
   * right before a turn's `result` resolves — see `synthesizeAgyDiffContent`.
   */
  private flushPendingEditRechecks(): void {
    const pending = this.pendingEditRecheck;
    this.pendingEditRecheck = [];
    for (const { toolCallId, file, diskOldText } of pending) {
      const diskNewText = this.readDiskTextForDiff(file);
      if (diskNewText === undefined || diskNewText === diskOldText) continue;
      const baselineKey = normalizeBaselineKey(file, this.cwd);
      this.sessionFileBaseline.set(baselineKey, diskNewText);
      const diff = synthesizeEditDiff({ path: file, oldText: diskOldText ?? "", newText: diskNewText });
      if (!diff) continue;
      this.sendNotification("session/update", {
        sessionId: this.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          content: [diff],
        },
      });
    }
  }

  private ensureAgyProc(overridePromptArgs?: string[]): ChildProcessWithoutNullStreams {
    if (this.agyProc && overridePromptArgs) {
      throw new Error("Antigravity process must be stopped before respawn");
    }
    if (this.agyProc && !this.agyProc.killed && this.agyProc.stdin.writable && !overridePromptArgs) {
      return this.agyProc;
    }

    const args: string[] = [];
    if (overridePromptArgs && overridePromptArgs.length > 0) {
      args.push(...overridePromptArgs);
      args.push("--output-format", "stream-json");
    } else {
      args.push(
        "--input-format", "stream-json",
        "--output-format", "stream-json",
      );
    }
    args.push("--print-timeout", this.printTimeout);

    if (this.cwd) {
      args.push("--add-dir", this.cwd);
    }
    const stagingDir = path.join(this.geminiHome, "staging");
    if (fs.existsSync(stagingDir)) {
      args.push("--add-dir", stagingDir);
    }

    if (this.currentModelId) {
      args.push("--model", this.currentModelId);
    }
    // Exactly as many `--effort` flags as this model accepts: one, or none.
    // See modelRequiresEffort for what the CLI rejects.
    if (this.effectiveModelRequiresEffort(this.currentModelId)) {
      args.push("--effort", this.effectiveEffort());
    }
    if (this.currentModeId === "plan") {
      args.push("--mode", "plan");
    }
    // Headless stream-json over stdio pipes has no interactive TTY for terminal confirmations
    // and no ACP permission-request protocol. Without --dangerously-skip-permissions, agy defaults
    // to "request-review", causing any command (including read-only 'git status') or file edit to
    // immediately fail with: "permission check failed ... user denied permission to run command".
    // In plan mode, --mode plan already restricts agy's planning behavior, while the adapter's
    // isImplementationPlanTool() intercepts implementation_plan.md and issues an x.ai/exit_plan_mode
    // review request for user confirmation.
    args.push("--dangerously-skip-permissions");
    if (this.activeConversationId) {
      args.push("--conversation", this.activeConversationId);
    }

    const proc = this.spawnFn(shellSafeCommand(this.agyPath), args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(this.agyPath),
    });

    this.agyProc = proc;
    const ioError = (error: Error) => {
      if (this.agyProc === proc) this.pendingPrompt?.reject(error);
    };
    proc.stdin.on("error", ioError);
    proc.stdout.on("error", ioError);
    proc.stderr.on("error", ioError);
    this.agyRl = createInterface({ input: proc.stdout });
    this.agyRl.on("error", ioError);
    this.agyRl.on("line", (line) => {
      if (this.agyProc === proc) this.handleAgyLine(line);
    });
    // Drained, not just piped: an undrained stderr deadlocks the child once the
    // pipe buffer fills, and the host logs whatever we write to ours.
    if (proc.stderr) {
      this.agyErrRl = createInterface({ input: proc.stderr });
      this.agyErrRl.on("error", ioError);
      this.agyErrRl.on("line", (line) => {
        if (this.agyProc === proc && line.trim()) {
          if (this.pendingPrompt) this.pendingPrompt.activityAt = Date.now();
          this.lastStderrBuffer.push(line);
          if (this.lastStderrBuffer.length > 50) this.lastStderrBuffer.shift();
          process.stderr.write(`[agy] ${line}\n`);
        }
      });
    }

    proc.on("exit", (code) => {
      if (this.agyProc !== proc) return;
      this.agyProc = undefined;
      const turn = this.pendingPrompt;
      if (turn && turn.state === "running") {
        turn.reject(new Error(code === 0 ? "Antigravity CLI exited without a turn result" : `Antigravity CLI exited with code ${code}`));
      }
    });
    proc.on("error", (error) => {
      if (this.agyProc !== proc) return;
      this.agyProc = undefined;
      this.pendingPrompt?.reject(error);
    });

    return proc;
  }

  handleAgyLine(line: string): void {
    const turn = this.pendingPrompt;
    if (turn) turn.activityAt = Date.now();
    if (!turn || turn.abort.signal.aborted || turn.state !== "running") return;
    const trimmed = line.trim();
    if (!trimmed) return;
    let ev: any;
    try {
      ev = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (ev.event === "init") {
      if (typeof ev.conversation_id === "string" && ev.conversation_id) {
        this.activeConversationId = ev.conversation_id;
        if (this.sessionId) {
          this.rememberConversation(this.sessionId, ev.conversation_id, {
            cwd: this.cwd,
            updatedAt: Date.now(),
          });
        }
      }
      return;
    }

    if (ev.event === "step_update") {
      const step = ev.step_update;
      if (!step) return;

      if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
        if (step.text_delta.trim()) turn.visible = true;
        this.sendNotification("session/update", {
          sessionId: this.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: step.text_delta,
            },
          },
        });
      }

      if (step.step_type === "tool") {
        const toolCallId = `tool-${step.step_index}`;
        const name = step.tool_name || step.tool_info?.name || "tool";
        const rawParams = step.tool_info?.parameters || {};
        const params = normalizeToolInput(name, rawParams);
        const kind = toolKind(name);
        const title = toolTitle(name, params);

        if (step.state === "ACTIVE") {
          turn.visible = true;
          if (turn.tools.has(toolCallId)) return;
          turn.tools.set(toolCallId, "open");
          // synthesizeAgyDiffContent is async (DONE polls disk — see there),
          // but the ACTIVE path never awaits anything itself, so this still
          // resolves before any later stdout line can be processed.
          const activeDiff = this.synthesizeAgyDiffContent(toolCallId, name, rawParams, "active", step.step_index, turn).then((content) => {
            if (turn.abort.signal.aborted || this.pendingPrompt !== turn) return;
            this.sendNotification("session/update", {
              sessionId: this.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId,
                title,
                kind,
                status: "in_progress",
                rawInput: params,
                ...(content && content.length ? { content } : {}),
              },
            });
          });
          this.pendingDiffPromises.push(activeDiff);
        } else if (step.state === "DONE" || step.state === "ERROR") {
          turn.visible = true;
          if (turn.tools.has(toolCallId) && turn.tools.get(toolCallId) !== "open") return;
          const isError = step.state === "ERROR";
          turn.tools.set(toolCallId, "finishing");
          const rawOutput = step.tool_info?.output ?? step.tool_info?.error?.message ?? (isError ? "Tool execution failed" : "completed");
          const output = isError ? sanitizeAgyToolErrorMessage(rawOutput) : rawOutput;
          // For an edit tool this polls disk for the write to actually land
          // (see waitForDiskChangeText) — up to ~3s before this update is
          // sent, which can reorder it after a later tool's own updates.
          // Accepted: negligible against a multi-second turn, and the
          // alternative (no poll) was a confirmed-live "+0 -0" diff. Tracked
          // in pendingDiffPromises so the turn's "result" handler can await
          // it — the poll can still be running when "result" arrives.
          const diffPromise = this.synthesizeAgyDiffContent(toolCallId, name, rawParams, isError ? "error" : "done", step.step_index, turn).then((content) => {
            if (turn.abort.signal.aborted || this.pendingPrompt !== turn) return;
            turn.tools.set(toolCallId, isError ? "failed" : "completed");
            this.sendNotification("session/update", {
              sessionId: this.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId,
              title,
              kind,
              status: isError ? "failed" : "completed",
              rawInput: params,
              rawOutput: typeof output === "string" ? { output } : output,
              ...(content && content.length ? { content } : {}),
            },
          });

          if (!isError && isImplementationPlanTool(name, rawParams)) {
            const planText = extractPlanText(rawParams, this.cwd);
            if (planText) {
              this.sendNotification("session/update", {
                sessionId: this.sessionId,
                update: {
                  sessionUpdate: "plan",
                  plan: planText,
                },
              });
            }
            if (this.currentModeId === "plan" || rawParams?.ArtifactMetadata?.RequestFeedback === true) {
              const planReqId = randomUUID();
              this.pendingExitPlanId = planReqId;
              this.writeJsonRpc({
                jsonrpc: "2.0",
                id: planReqId,
                method: "x.ai/exit_plan_mode",
                params: {
                  sessionId: this.sessionId,
                  planContent: planText,
                },
              });
            }
          }
          });
          this.pendingDiffPromises.push(diffPromise);
        }
      }

      if (step.usage && this.pendingPrompt) {
        const u = step.usage;
        this.pendingPrompt.usage.inputTokens = u.input_tokens ?? this.pendingPrompt.usage.inputTokens;
        this.pendingPrompt.usage.outputTokens = u.output_tokens ?? this.pendingPrompt.usage.outputTokens;
        this.pendingPrompt.usage.thoughtTokens = u.thinking_tokens ?? this.pendingPrompt.usage.thoughtTokens;
        this.pendingPrompt.usage.totalTokens = u.total_tokens ?? this.pendingPrompt.usage.totalTokens;
        this.lastUsage = { ...this.pendingPrompt.usage };


      }
      return;
    }

    if (ev.event === "result") {
      const result = ev.result;
      turn.state = "finalizing";
      if (result?.usage) {
        const u = result.usage;
        turn.usage.inputTokens = u.input_tokens ?? turn.usage.inputTokens;
        turn.usage.outputTokens = u.output_tokens ?? turn.usage.outputTokens;
        turn.usage.thoughtTokens = u.thinking_tokens ?? turn.usage.thoughtTokens;
        turn.usage.totalTokens = u.total_tokens ?? turn.usage.totalTokens;
      }
      if (result?.status === "ERROR") turn.reject(new Error(result.error || "Antigravity reported an error"));
      else turn.resolve({ stopReason: "end_turn", usage: turn.usage });
    }
  }

  private executePrompt(id: number | string, promptText: string): Promise<void> {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const turn: AgyTurn = {
      id, text: promptText, state: "queued", abort: new AbortController(),
      usage: { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, totalTokens: 0 },
      tools: new Map(), visible: false, resolve: () => {}, reject: () => {}, done, finish,
      activityAt: Date.now(),
    };
    this.promptQueue.push(turn);
    this.drainPromptQueue();
    return done;
  }

  private drainPromptQueue(): void {
    if (this.pendingPrompt || this.closing) return;
    if (this.processBlocked) {
      for (const turn of this.promptQueue.splice(0)) {
        this.sendError(turn.id, -32603, "Antigravity process exit was not confirmed; restart blocked");
        turn.state = "terminal";
        turn.finish();
      }
      return;
    }
    const turn = this.promptQueue.shift();
    if (!turn) return;
    turn.state = "claimed";
    this.pendingPrompt = turn;
    void this.runTurn(turn);
  }

  private async runTurn(turn: AgyTurn): Promise<void> {
    const watchdog = this.watchdogIdleTimeoutMs ? setInterval(() => {
      if (turn.state !== "running" || this.humanWaitActive || this.pendingExitPlanId != null) {
        turn.activityAt = Date.now();
        return;
      }
      if (Date.now() - turn.activityAt >= this.watchdogIdleTimeoutMs) {
        turn.state = "finalizing";
        process.stderr.write("[agy] idle watchdog stopped the turn; next prompt will resume the session\n");
        turn.reject(new Error("Antigravity idle watchdog stopped an unresponsive turn; send another prompt to resume"));
      }
    }, 1000) : undefined;
    watchdog?.unref();
    try {
      const useStdin = await abortable(this.probeSupportsInputFormat(), turn.abort.signal);
      if (!useStdin && grokCliNeedsShell(this.agyPath))
        throw new Error("Antigravity compatibility mode on Windows requires a native executable; use agy.exe instead of a .cmd shim");
      let result: any;
      for (let attempt = 0; attempt < 2; attempt++) {
        if (this.stopPromise) await abortable(this.stopPromise, turn.abort.signal);
        if (this.respawnBeforeNextPrompt || !useStdin) {
          await abortable(this.killAgyProc(), turn.abort.signal);
          this.respawnBeforeNextPrompt = false;
        }
        if (this.processBlocked) throw new Error("Antigravity restart blocked");
        this.lastStderrBuffer.length = 0;
        const response = new Promise<any>((resolve, reject) => { turn.resolve = resolve; turn.reject = reject; });
        // Observe errors even if a synchronous spawn failure prevents awaiting response.
        void response.catch(() => {});
        turn.state = "running";
        try {
          this.skillCommands = discoverAgySkills(this.cwd, os.homedir());
          const instructions = [this.toolRules === "prompt"
            ? "Antigravity tool rules: use absolute file paths; omit ArtifactMetadata for workspace files; supply Pattern for find_by_name." : "",
          agySkillInstructions(turn.text, this.skillCommands)].filter(Boolean).join("\n");
          const text = instructions ? `<companions_adapter_instructions>\n${instructions}\n</companions_adapter_instructions>\n\n${turn.text}` : turn.text;
          const proc = useStdin ? this.ensureAgyProc() : this.ensureAgyProc(["-p", text]);
          if (turn.abort.signal.aborted) {
            await this.killAgyProc();
            throw new Error("Turn cancelled");
          }
          if (useStdin) {
            proc.stdin.write(JSON.stringify({ event: "user", message: { role: "user", content: text } }) + "\n", error => {
              if (error && this.pendingPrompt === turn && !turn.abort.signal.aborted) turn.reject(error);
            });
          }
          result = await abortable(response, turn.abort.signal);
          break;
        } catch (error) {
          const message = `${(error as Error).message}\n${this.lastStderrBuffer.join("\n")}`;
          if (attempt === 0 && !turn.abort.signal.aborted && !turn.visible && /requires --effort|conflicts with --effort/i.test(message)) {
            this.effortRequirementOverrides.set(this.currentModelId, /requires --effort/i.test(message));
            turn.state = "claimed";
            await abortable(this.killAgyProc(), turn.abort.signal);
            continue;
          }
          throw error;
        }
      }
      await abortable(Promise.allSettled(this.pendingDiffPromises), turn.abort.signal);
      this.flushPendingEditRechecks();
      if (!turn.visible) {
        this.sendError(turn.id, -32000, "Antigravity completed the turn without visible assistant or tool output");
      } else {
        this.closeTurnTools(turn);
        this.lastUsage = { ...turn.usage };
        this.sendResponse(turn.id, result);
      }
    } catch (error) {
      try { await this.killAgyProc(); } catch { /* processBlocked keeps the FIFO closed */ }
      this.closeTurnTools(turn);
      if (this.processBlocked) this.sendError(turn.id, -32603, "Antigravity process exit was not confirmed; restart blocked");
      else if (turn.abort.signal.aborted) this.sendResponse(turn.id, { stopReason: "cancelled", usage: turn.usage });
      else this.sendError(turn.id, -32603, (error as Error).message || "Prompt error");
    } finally {
      clearInterval(watchdog);
      this.closeTurnTools(turn);
      this.pendingExitPlanId = undefined;
      this.humanWaitActive = false;
      turn.state = "terminal";
      this.pendingWriteOldText.clear();
      this.pendingEditRecheck = [];
      this.pendingDiffPromises = [];
      if (this.pendingPrompt === turn) this.pendingPrompt = undefined;
      turn.finish();
      this.drainPromptQueue();
    }
  }

  private closeTurnTools(turn: AgyTurn): void {
    for (const [id, status] of turn.tools) {
      if (status !== "open" && status !== "finishing") continue;
      turn.tools.set(id, "failed");
      this.sendNotification("session/update", { sessionId: this.sessionId,
        update: agyTerminalToolUpdate(id, turn.abort.signal.aborted) });
    }
  }

  private publishSkillCommands(): void {
    this.skillCommands = discoverAgySkills(this.cwd, os.homedir());
    this.sendNotification("session/update", { sessionId: this.sessionId,
      update: { sessionUpdate: "available_commands_update", availableCommands: this.skillCommands } });
  }

}

// When invoked directly as a standalone Node script
if (require.main === module) {
  const server = new AgyAcpAdapterServer();
  server.sweepStagedImages();
  server.start();

  process.on("SIGINT", () => {
    void server.shutdown().then(() => process.exit(0), () => process.exit(1));
  });
  process.on("SIGTERM", () => {
    void server.shutdown().then(() => process.exit(0), () => process.exit(1));
  });
}
