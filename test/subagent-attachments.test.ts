import { describe, expect, it } from "vitest";
import { makeSubagentChip, makeTerminalChip } from "../src/context-chips";
import { composerSubagentDirectives, renderDirectiveBlock, peelDirectiveBlock } from "../src/subagent-directives";
import { parseSubagentAttachments } from "../src/shared/subagent-chip";
import { buildPrompt } from "../src/prompt-builder";
import { enqueueQueuedSend, queuedSendsMessage } from "../src/queued-send";

describe("subagent attachment directives", () => {
  it("merges identical text and attachment targets and preserves multiple models", () => {
    const chips = [makeSubagentChip("codex", "a", "Model A"), makeSubagentChip("codex", "b", "Model B")];
    const parsed = composerSubagentDirectives("Investigate @subagent:codex/a", [...chips, chips[0]]);
    expect(parsed.text).toBe("Investigate");
    expect(parsed.directives).toHaveLength(2);
    expect(parsed.directives.map(directive => directive.model)).toEqual(["a", "b"]);
    expect(parsed.directives.every(directive => directive.strength === "must")).toBe(true);
    const block = renderDirectiveBlock(parsed.directives);
    expect(peelDirectiveBlock(block).directives).toEqual(parsed.directives);
    expect(parseSubagentAttachments(`Investigate\n\n${block}`)).toEqual({ body: "Investigate", chips });
  });

  it("refuses the explicit no-subagents conflict and ignores hidden attachments", () => {
    const chip = makeSubagentChip("codex", "a");
    expect(() => composerSubagentDirectives("@subagent:none", [chip])).toThrow("before sending");
    expect(composerSubagentDirectives("hello", [{ ...chip, hidden: true }]).directives).toEqual([]);
  });

  it("keeps model attachments out of file and terminal context", () => {
    const chips = [makeSubagentChip("codex", "a"), makeTerminalChip({ label: "Shell", bytes: 2 })];
    const prompt = buildPrompt("Investigate", chips, { readFile: () => { throw new Error("must not read a model as a file"); }, extName: () => "", contextChipPayload: chip => chip.kind === "terminal" ? { kind: "terminal", label: "Shell", text: "OK" } : undefined });
    expect(prompt).toContain("Terminal output from");
    expect(prompt).not.toContain("subagent:");
    expect(prompt).not.toContain("vscode-context");
  });

  it("snapshots attachments in queued contributions", () => {
    const chip = makeSubagentChip("codex", "a", "Model A");
    const queued = enqueueQueuedSend([], "Investigate", [chip]);
    chip.modelName = "Changed";
    const msg = queuedSendsMessage(queued);
    expect(msg.queued?.[0].chips?.[0]).toMatchObject({ kind: "subagent", modelName: "Model A" });
  });

  it("decodes escaped labels and slash-containing model IDs and leaves lookalike user text intact", () => {
    const block = renderDirectiveBlock([{ id: "d1", strength: "must", provider: "codex", model: "family/model", modelName: 'A & "B"' }]);
    expect(parseSubagentAttachments(block).chips[0].modelName).toBe('A & "B"');
    expect(peelDirectiveBlock(block).directives[0].model).toBe("family/model");
    expect(parseSubagentAttachments(`${block}\nUser words`).body).toBe(`${block}\nUser words`);
  });
});
