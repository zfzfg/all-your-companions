/**
 * Handoff packets between crew stages (AP-17 §7.5, §2.1 point 7).
 *
 * A packet is what the next stage's briefing is built from, and what the gate
 * displays. Building it is pure. Caps exist so stage N does not spend the
 * briefing's savings on instruction tax: summary 2 000 characters, findings
 * 40, verify tail 2 000; path lists uncapped. The previous `result.md` body
 * never travels — only `resultPath`.
 *
 * Recipe R7: no vscode, no fs, no clock. The caller stamps `durationMs`.
 */

import type { AcpProvider } from "./acp-backend";
import type { EffortLevel } from "./acp";
import {
  extractCompanionsResultJson,
  makeBriefing,
  parseResult,
  type BriefingInput,
  type FileReconciliation,
} from "./briefing";
import { subagentReturnFormat } from "./companion-subagents";
import type { PromptContract, WorkflowDefinition, WorkflowStage } from "./workflow";
import { findStage } from "./workflow";

export const HANDOFF_VERSION = 1 as const;
export const SUMMARY_CAP = 2000;
export const FINDINGS_CAP = 40;
export const VERIFY_TAIL_CAP = 2000;

export type HandoffStatus = "done" | "failed" | "cancelled" | "interrupted" | "skipped";

export type FindingSeverity = "blocker" | "major" | "minor" | "nit";

export interface HandoffFinding {
  id: string;
  severity: FindingSeverity;
  file?: string;
  line?: number;
  text: string;
}

export interface HandoffPlanStep {
  id: string;
  title: string;
  acceptance?: string;
  files?: string[];
}

export interface HandoffVerify {
  command: string;
  exitCode: number;
  outputTail: string;
}

export interface HandoffPacket {
  version: 1;
  runId: string;
  stageId: string;
  stageOrdinal: number;
  visit: number;
  role: string;
  target: { provider: AcpProvider; model?: string; effort?: string; modelVerified: boolean };
  status: HandoffStatus;
  summary: string;
  planSteps?: HandoffPlanStep[];
  verdict?: string;
  findings?: HandoffFinding[];
  openQuestions?: string[];
  filesReported: string[];
  filesObserved: string[];
  unreported: string[];
  claimedOnly: string[];
  verify?: HandoffVerify;
  userNotes?: string;
  tokens?: number;
  durationMs: number;
  resultPath: string;
  provenance?: string[];
}

export interface CompanionsResultBlock {
  summary?: string;
  findings?: unknown;
  filesChanged?: unknown;
  openQuestions?: unknown;
  verdict?: unknown;
  planSteps?: unknown;
  questions?: unknown;
  stepsDone?: unknown;
  deviations?: unknown;
  fixed?: unknown;
  notFixed?: unknown;
  acceptanceCheck?: unknown;
  [key: string]: unknown;
}

export function extractCompanionsResult(markdown: string): CompanionsResultBlock | undefined {
  return extractCompanionsResultJson(markdown) as CompanionsResultBlock | undefined;
}

function clip(text: string, cap: number): string {
  const value = String(text ?? "");
  if (value.length <= cap) return value;
  return `${value.slice(0, Math.max(0, cap - 1)).trimEnd()}…`;
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    const one = typeof value === "string" ? value.trim() : "";
    return one ? [one] : [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function asSeverity(value: unknown): FindingSeverity {
  if (value === "blocker" || value === "major" || value === "minor" || value === "nit") return value;
  return "minor";
}

export function parseFindings(value: unknown): HandoffFinding[] {
  if (!Array.isArray(value)) {
    return asStringList(value).map((text, i) => ({ id: `F${i + 1}`, severity: "minor" as const, text }));
  }
  const out: HandoffFinding[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry === "string" && entry.trim()) {
      out.push({ id: `F${i + 1}`, severity: "minor", text: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const text = typeof obj.text === "string" ? obj.text.trim() : typeof obj.message === "string" ? obj.message.trim() : "";
    if (!text) continue;
    const finding: HandoffFinding = {
      id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `F${i + 1}`,
      severity: asSeverity(obj.severity),
      text,
    };
    if (typeof obj.file === "string" && obj.file.trim()) finding.file = obj.file.trim();
    if (typeof obj.line === "number" && Number.isFinite(obj.line)) finding.line = Math.floor(obj.line);
    out.push(finding);
  }
  return out;
}

export function parsePlanSteps(value: unknown): HandoffPlanStep[] {
  if (!Array.isArray(value)) return [];
  const out: HandoffPlanStep[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const entry = value[i];
    if (typeof entry === "string" && entry.trim()) {
      out.push({ id: `S${i + 1}`, title: entry.trim() });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const obj = entry as Record<string, unknown>;
    const title = typeof obj.title === "string" ? obj.title.trim() : typeof obj.content === "string" ? obj.content.trim() : "";
    if (!title) continue;
    const step: HandoffPlanStep = {
      id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : `S${i + 1}`,
      title,
    };
    if (typeof obj.acceptance === "string" && obj.acceptance.trim()) step.acceptance = obj.acceptance.trim();
    const files = asStringList(obj.files);
    if (files.length) step.files = files;
    out.push(step);
  }
  return out;
}

/**
 * Numbered / bulleted plan in prose — the D17 fallback for a planner that
 * did not emit a `companions-result` block. Never invents structure the
 * text does not have: no matches means an empty list, and the gate says so.
 */
export function parsePlanStepsFromProse(markdown: string): HandoffPlanStep[] {
  const lines = String(markdown ?? "").replace(/\r\n/g, "\n").split("\n");
  const out: HandoffPlanStep[] = [];
  for (const line of lines) {
    const match = /^\s*(?:#{1,6}\s+)?(?:(?:\d+)[.)]|[-*+])\s+(.+)$/.exec(line);
    if (!match) continue;
    const title = match[1].replace(/^[`*_]+|[`*_]+$/g, "").trim();
    if (!title || title.length < 3) continue;
    out.push({ id: `S${out.length + 1}`, title });
  }
  return out;
}

export function verifyStatus(verify: HandoffVerify | undefined): "passed" | "failed" | "none" {
  if (!verify) return "none";
  return verify.exitCode === 0 ? "passed" : "failed";
}

export function highestFindingSeverity(findings: readonly HandoffFinding[] | undefined): FindingSeverity | undefined {
  if (!findings?.length) return undefined;
  const rank: Record<FindingSeverity, number> = { blocker: 4, major: 3, minor: 2, nit: 1 };
  let best: FindingSeverity | undefined;
  for (const finding of findings) {
    if (!best || rank[finding.severity] > rank[best]) best = finding.severity;
  }
  return best;
}

export function capHandoffPacket(packet: HandoffPacket): HandoffPacket {
  return {
    ...packet,
    summary: clip(packet.summary, SUMMARY_CAP),
    ...(packet.findings ? { findings: packet.findings.slice(0, FINDINGS_CAP) } : {}),
    ...(packet.verify
      ? { verify: { ...packet.verify, outputTail: clip(packet.verify.outputTail, VERIFY_TAIL_CAP) } }
      : {}),
  };
}

export function buildHandoffPacket(input: {
  runId: string;
  stageId: string;
  stageOrdinal: number;
  visit: number;
  role: string;
  target: { provider: AcpProvider; model?: string; effort?: EffortLevel | string; modelVerified: boolean };
  status: HandoffStatus;
  rawReply: string;
  filesReported?: readonly string[];
  filesObserved?: readonly string[];
  reconciliation?: FileReconciliation;
  verify?: { command: string; exitCode: number; output: string };
  userNotes?: string;
  tokens?: number;
  durationMs: number;
  resultPath: string;
  contract?: PromptContract;
}): HandoffPacket {
  const block = extractCompanionsResult(input.rawReply);
  const parsed = parseResult(input.rawReply);
  const recon = input.reconciliation ?? {
    touched: [],
    unreported: [],
    claimedOnly: [],
  };
  const summary = (typeof block?.summary === "string" && block.summary.trim())
    ? block.summary.trim()
    : parsed.summary;
  const filesReported = asStringList(block?.filesChanged).length
    ? asStringList(block?.filesChanged)
    : [...(input.filesReported ?? parsed.files)];
  const filesObserved = [...(input.filesObserved ?? [])];
  const findings = parseFindings(block?.findings);
  const planFromBlock = parsePlanSteps(block?.planSteps);
  const planSteps = planFromBlock.length
    ? planFromBlock
    : (input.contract?.output.resultBlock.required.includes("planSteps")
      ? parsePlanStepsFromProse(input.rawReply)
      : []);
  const verdict = typeof block?.verdict === "string" ? block.verdict.trim() : "";
  const openQuestions = asStringList(block?.openQuestions).length
    ? asStringList(block?.openQuestions)
    : parsed.open;
  const provenance: string[] = [];
  if (!block) {
    provenance.push("No companions-result block; headings (or prose) were used instead.");
  }
  if (input.contract && contractFieldMissing(input.contract, block, planSteps, verdict)) {
    const missing = input.contract.output.resultBlock.required.filter((field) => {
      if (field === "verdict") return !verdict;
      if (field === "planSteps") return !planSteps.length;
      if (field === "findings") return false;
      if (field === "summary") return !summary;
      if (field === "filesChanged") return !filesReported.length;
      return block?.[field] === undefined;
    });
    if (missing.length) {
      provenance.push(`${input.role} returned no ${missing.join(", ")} block.`);
    }
  }
  const verify = input.verify
    ? {
        command: input.verify.command,
        exitCode: input.verify.exitCode,
        outputTail: clip(input.verify.output ?? "", VERIFY_TAIL_CAP),
      }
    : undefined;
  return capHandoffPacket({
    version: 1,
    runId: input.runId,
    stageId: input.stageId,
    stageOrdinal: input.stageOrdinal,
    visit: input.visit,
    role: input.role,
    target: {
      provider: input.target.provider,
      ...(input.target.model ? { model: input.target.model } : {}),
      ...(input.target.effort ? { effort: String(input.target.effort) } : {}),
      modelVerified: input.target.modelVerified,
    },
    status: input.status,
    summary: clip(summary, SUMMARY_CAP),
    ...(planSteps.length ? { planSteps } : {}),
    ...(verdict ? { verdict } : {}),
    ...(findings.length ? { findings: findings.slice(0, FINDINGS_CAP) } : {}),
    ...(openQuestions.length ? { openQuestions } : {}),
    filesReported,
    filesObserved,
    unreported: [...recon.unreported],
    claimedOnly: [...recon.claimedOnly],
    ...(verify ? { verify } : {}),
    ...(input.userNotes?.trim() ? { userNotes: input.userNotes.trim() } : {}),
    ...(typeof input.tokens === "number" ? { tokens: input.tokens } : {}),
    durationMs: input.durationMs,
    resultPath: input.resultPath,
    ...(provenance.length ? { provenance } : {}),
  });
}

function contractFieldMissing(
  contract: PromptContract,
  block: CompanionsResultBlock | undefined,
  planSteps: HandoffPlanStep[],
  verdict: string,
): boolean {
  return contract.output.resultBlock.required.some((field) => {
    if (field === "verdict") return !verdict;
    if (field === "planSteps") return !planSteps.length;
    if (field === "summary") return !block?.summary && field === "summary";
    return block?.[field] === undefined;
  });
}

export function verdictUnreadable(packet: HandoffPacket, contract: PromptContract | undefined): boolean {
  if (!contract?.output.resultBlock.required.includes("verdict")) return false;
  const allowed = contract.output.resultBlock.verdict?.values ?? [];
  if (!packet.verdict) return true;
  if (!allowed.length) return false;
  return !allowed.includes(packet.verdict);
}

/**
 * The stage's `returnFormat` — the ONE machine channel (§2.1 point 1).
 *
 * Built from the contract's required fields so a planner is asked for
 * `planSteps` and a reviewer for `verdict`, without also demanding the
 * `RESULT_FORMAT` heading set.
 */
export function stageReturnFormat(contract: PromptContract): string {
  const required = contract.output.resultBlock.required;
  const example: Record<string, unknown> = {};
  for (const field of required) {
    if (field === "verdict") {
      example.verdict = (contract.output.resultBlock.verdict?.values ?? ["pass"])[0];
    } else if (field === "findings") {
      example.findings = [{ id: "F1", severity: "major", file: "path", line: 1, text: "what is wrong" }];
    } else if (field === "planSteps") {
      example.planSteps = [{ id: "S1", title: "step title", acceptance: "done when", files: ["path"] }];
    } else if (field === "filesChanged") {
      example.filesChanged = ["paths you edited; empty if you edited nothing"];
    } else if (field === "openQuestions") {
      example.openQuestions = [];
    } else if (field === "questions") {
      example.questions = ["at most five questions whose answers would change the plan"];
    } else {
      example[field] = "";
    }
  }
  if (!example.summary && !required.includes("summary")) {
    example.summary = "one or two sentences on what you found or did";
  }
  const lines = [
    "End your reply with one fenced block, exactly like this, and nothing after it:",
    "",
    "```companions-result",
    JSON.stringify(example, null, 2),
    "```",
    "",
    "Write whatever prose helps above the block. The block is what is read back.",
  ];
  if (contract.output.sections.length) {
    lines.push("", `Useful prose headings, if you want them: ${contract.output.sections.join(", ")}.`);
  }
  return lines.join("\n");
}

export function resolveInputPath(
  from: string,
  ctx: {
    idea: string;
    userNotes?: string;
    attachedFiles?: readonly string[];
    packets: ReadonlyMap<string, HandoffPacket>;
  },
): { text?: string; paths?: string[]; note?: string } {
  if (from === "idea") return { text: ctx.idea };
  if (from === "userNotes") return ctx.userNotes?.trim() ? { text: ctx.userNotes.trim() } : { note: "the user left no notes" };
  if (from === "files.attached") {
    return ctx.attachedFiles?.length
      ? { paths: [...ctx.attachedFiles] }
      : { note: "no files were attached" };
  }
  if (from === "repo.root") return { note: "the repository root — open what you need; paths, never contents" };
  const dot = from.indexOf(".");
  if (dot <= 0) return { note: `unknown input '${from}'` };
  const stageId = from.slice(0, dot);
  const field = from.slice(dot + 1);
  const packet = ctx.packets.get(stageId);
  if (!packet) return { note: `stage '${stageId}' has not run` };
  return fieldFromPacket(packet, field);
}

function fieldFromPacket(packet: HandoffPacket, field: string): { text?: string; paths?: string[]; note?: string } {
  if (field === "summary") return packet.summary ? { text: clip(packet.summary, SUMMARY_CAP) } : { note: `${packet.role} returned no summary` };
  if (field === "verdict") return packet.verdict ? { text: packet.verdict } : { note: `${packet.role} returned no verdict` };
  if (field === "resultPath") return { text: packet.resultPath };
  if (field === "userNotes") return packet.userNotes ? { text: packet.userNotes } : { note: "no notes from the user" };
  if (field === "planSteps") {
    if (!packet.planSteps?.length) return { note: `${packet.role} returned no plan steps` };
    return {
      text: packet.planSteps.map((step) => {
        const bits = [`${step.id}. ${step.title}`];
        if (step.acceptance) bits.push(`Acceptance: ${step.acceptance}`);
        if (step.files?.length) bits.push(`Files: ${step.files.join(", ")}`);
        return bits.join("\n");
      }).join("\n\n"),
    };
  }
  if (field === "findings") {
    if (!packet.findings?.length) return { note: `${packet.role} reported no findings` };
    return {
      text: packet.findings.slice(0, FINDINGS_CAP).map((finding) => {
        const loc = [finding.file, finding.line != null ? `:${finding.line}` : ""].join("");
        return `- [${finding.severity}] ${finding.id}${loc ? ` ${loc}` : ""} ${finding.text}`;
      }).join("\n"),
    };
  }
  if (field === "findings.files") {
    const files = [...new Set((packet.findings ?? []).map((f) => f.file).filter((p): p is string => !!p))];
    return files.length ? { paths: files } : { note: "no finding named a file" };
  }
  if (field === "files" || field === "filesReported") {
    return packet.filesReported.length ? { paths: [...packet.filesReported] } : { note: `${packet.role} named no files` };
  }
  if (field === "filesObserved") {
    return packet.filesObserved.length ? { paths: [...packet.filesObserved] } : { note: "the host observed no edits" };
  }
  if (field === "verify") {
    if (!packet.verify) return { note: "no verify command ran" };
    const tail = clip(packet.verify.outputTail, VERIFY_TAIL_CAP);
    return {
      text: `\`${packet.verify.command}\` exited ${packet.verify.exitCode}${tail ? `:\n${tail}` : "."}`,
    };
  }
  if (field === "openQuestions") {
    return packet.openQuestions?.length
      ? { text: packet.openQuestions.map((q) => `- ${q}`).join("\n") }
      : { note: "no open questions" };
  }
  return { note: `packet has no field '${field}'` };
}

/**
 * Build the next stage's briefing from the contract's `inputs[]` only.
 *
 * Caps are applied at packet-build time AND again here, so a caller that
 * skipped `capHandoffPacket` still cannot paste a 20k summary into a brief.
 * `resultPath` may be named as a path; the result body is never inlined.
 */
export function briefingFromContract(opts: {
  runId: string;
  step: number;
  idea: string;
  stage: WorkflowStage;
  def: WorkflowDefinition;
  packets: ReadonlyMap<string, HandoffPacket>;
  userNotes?: string;
  attachedFiles?: readonly string[];
  verifyCommand?: string;
}): BriefingInput {
  const contract = opts.def.contracts[opts.stage.contract];
  const files: string[] = [];
  const decisions: string[] = [];
  const provenance: string[] = [];
  const forbidden = [...(contract?.forbidden ?? [])];
  if (opts.stage.profile === "read-only") {
    forbidden.push("Do not edit, create or delete files.");
    forbidden.push("Do not run commands that modify the workspace.");
  }
  const taskParts: string[] = [];
  if (contract?.purpose) taskParts.push(contract.purpose);
  if (contract?.instructions) taskParts.push(contract.instructions);

  for (const input of contract?.inputs ?? []) {
    const resolved = resolveInputPath(input.from, {
      idea: opts.idea,
      userNotes: opts.userNotes,
      attachedFiles: opts.attachedFiles,
      packets: opts.packets,
    });
    if (resolved.paths?.length) {
      for (const path of resolved.paths) if (!files.includes(path)) files.push(path);
      decisions.push(`${input.as}: ${resolved.paths.join(", ")}`);
      provenance.push(`${input.as}: ${resolved.paths.length} path(s) from ${input.from}.`);
    } else if (resolved.text) {
      decisions.push(`${input.as}:\n${resolved.text}`);
      provenance.push(`${input.as}: from ${input.from}.`);
    } else {
      provenance.push(`${input.as}: ${resolved.note ?? `nothing at ${input.from}`}.`);
    }
  }
  if (opts.verifyCommand && isWriteLike(opts.stage)) {
    decisions.push(`Verify command to run after you finish: \`${opts.verifyCommand}\`.`);
  }
  // A briefing that named result.md as an input still only carries the PATH.
  // The child opens the file if it must; pasting the body would undo §2.1.7.
  return makeBriefing({
    runId: opts.runId,
    step: opts.step,
    goal: opts.idea,
    task: taskParts.join("\n\n") || opts.stage.title,
    acceptance: contract?.acceptance ?? `This stage is done when "${opts.stage.title}" holds.`,
    files,
    decisions,
    forbidden,
    returnFormat: contract ? stageReturnFormat(contract) : subagentReturnFormat(),
    provenance,
  });
}

function isWriteLike(stage: WorkflowStage): boolean {
  return stage.profile === "scoped-edit" || stage.profile === "inherit";
}

export function lastWritingPacket(
  def: WorkflowDefinition,
  packets: Iterable<HandoffPacket>,
): HandoffPacket | undefined {
  let last: HandoffPacket | undefined;
  for (const packet of packets) {
    const stage = findStage(def, packet.stageId);
    if (stage && isWriteLike(stage) && packet.verify) last = packet;
  }
  return last;
}

/** Packet field used by transition `verify:` for a read-only stage. */
export function verifyForTransitions(
  def: WorkflowDefinition,
  packet: HandoffPacket,
  packets: Iterable<HandoffPacket>,
): HandoffVerify | undefined {
  if (packet.verify) return packet.verify;
  const stage = findStage(def, packet.stageId);
  if (!stage || isWriteLike(stage)) return packet.verify;
  return lastWritingPacket(def, packets)?.verify;
}
