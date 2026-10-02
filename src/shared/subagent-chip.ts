import type { AcpProvider } from "../acp-backend";
import type { SubagentChip } from "../context-chips";

/** Peel only the trailing directive envelope emitted by the host. */
export function parseSubagentAttachments(text: string): { body: string; chips: SubagentChip[] } {
  const match = /(?:^|\n\n)<companions-subagent-directives>([\s\S]*?)<\/companions-subagent-directives>\s*$/.exec(text);
  if (!match) {
    const forbid = /(?:^|\n\n)<companions-subagent-directives mode="forbid"\/>\s*$/.exec(text);
    return { body: forbid ? `${text.slice(0, forbid.index).trim()}\n@subagent:none`.trim() : text, chips: [] };
  }
  const chips: SubagentChip[] = [];
  const mentions: string[] = [];
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&");
  for (const directive of match[1].matchAll(/<directive\s+([^>]+?)(?:\/>|>([\s\S]*?)<\/directive>)/g)) {
    const attrs = Object.fromEntries([...directive[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(attr => [attr[1], decode(attr[2])]));
    if (attrs.provider && attrs.model) {
      const id = `subagent:${attrs.provider}:${attrs.model}`;
      if (!chips.some(chip => chip.id === id)) chips.push({ kind: "subagent", id,
        provider: attrs.provider as AcpProvider, model: attrs.model, modelName: attrs.modelName || attrs.model,
        relPath: attrs.modelName || attrs.model, hidden: false });
    } else if (attrs.role) mentions.push(`@role:${attrs.role}`);
    else mentions.push(`@subagent${attrs.provider ? ":" + attrs.provider : ""}`);
  }
  return { body: [text.slice(0, match.index).trim(), ...mentions].filter(Boolean).join("\n"), chips };
}
