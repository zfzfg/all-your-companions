/** Browser entry: runtime imports must stay pure; host-only types are erased. */
export { HOST_MESSAGE_TYPES, WEBVIEW_MESSAGE_TYPES } from "./protocol";
export { EXTENSION_HOST_SLASH_COMMANDS, isAdvertisedSkill } from "./slash-filter";
export { contextChipLabel, contextChipTitle, formatChipBytes } from "./shared/context-chip";
export { explicitVisibleChips, queuedSendsText } from "./shared/queued-send";
import { HOST_MESSAGE_TYPES } from "./protocol";
import { getSlashQuery as slashQuery, applySlashPick as slashPick, filterCommands as commandFilter, type SlashCmd } from "./slash-filter";
import { explicitVisibleChips } from "./shared/queued-send";
import type { ContextChip } from "./context-chips";

const hostTypes: ReadonlySet<string> = new Set(HOST_MESSAGE_TYPES);
export function isKnownHostMessage(type: string): boolean { return hostTypes.has(type); }

// Normalize untyped browser inputs before calling the same host algorithms.
export function getSlashQuery(text: string, caret: number) {
  const src = text == null ? "" : String(text);
  return slashQuery(src, Math.max(0, Math.min(Number(caret) || 0, src.length)));
}
export function applySlashPick(text: string, caret: number, name: string) {
  const src = text == null ? "" : String(text);
  return slashPick(src, Math.max(0, Math.min(Number(caret) || 0, src.length)), name);
}
export function filterCommands(commands: SlashCmd[], query: string): SlashCmd[] {
  const list = Array.isArray(commands) ? commands : [];
  const q = String(query || "");
  return commandFilter(q ? list.filter(c => c && typeof c.name === "string") : list, q);
}
export function composerHasSendIntent(text: string, chips: readonly ContextChip[]): boolean {
  return !!String(text || "").trim() || explicitVisibleChips(chips || []).length > 0;
}
export interface QueueView { text: string; chips: ContextChip[] }
export function normalizeQueuedSends(msg: { queued?: QueueView[]; items?: string[] } | null): QueueView[] {
  if (msg && Array.isArray(msg.queued)) return msg.queued.map(entry => ({
    text: typeof entry?.text === "string" ? entry.text : String(entry || ""),
    chips: Array.isArray(entry?.chips) ? entry.chips : [],
  }));
  const items = msg && Array.isArray(msg.items) ? msg.items : [];
  return items.map(text => ({ text: String(text || ""), chips: [] }));
}
export function queuedSendsChips(entries: readonly QueueView[] = []): ContextChip[] {
  const chips: ContextChip[] = [];
  for (const entry of entries) if (Array.isArray(entry.chips)) chips.push(...entry.chips);
  return chips;
}
export { parseSubagentAttachments } from "./shared/subagent-chip";

export { computeLineDiff } from "./shared/line-diff";
