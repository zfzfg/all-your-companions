import type { ContextChip } from "../context-chips";

/** Ambient editor context is not user send intent. Keep staged attachment order. */
export function explicitVisibleChips(chips: readonly ContextChip[] = []): ContextChip[] {
  return chips.filter(chip => chip && !chip.hidden && !String(chip.id || "").startsWith("implicit:"));
}

/** Empty contributions still preserve the queue's paragraph boundaries. */
export function queuedSendsText(entries: readonly { text: string }[] = []): string {
  return entries.map(entry => entry.text || "").join("\n\n");
}
