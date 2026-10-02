import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click, type Harness } from "./webview-harness";
import { makeSubagentChip } from "../src/context-chips";
import { renderDirectiveBlock } from "../src/subagent-directives";

function openPicker(h: Harness) {
  click(h.window, h.doc.getElementById("add-btn") as HTMLElement);
  const row = [...h.doc.querySelectorAll("#add-popover .toolbar-popover-item")]
    .find(row => row.textContent === "Add subagent") as HTMLElement;
  click(h.window, row);
}

function targets(h: Harness, value = "auto") {
  dispatch(h.window, { type: "sessionDelegation", value, targets: [
    { provider: "codex", name: "Codex", eligible: true, models: [{ id: "model-a", label: "Model A" }, { id: "model-b", label: "Model B" }] },
    { provider: "claude", name: "Claude", eligible: false, models: [{ id: "hidden" }] },
  ] });
}

describe("subagent model attachments", () => {
  it("offers grouped models and adds an attachment without switching the main model", () => {
    const h = bootWebview();
    targets(h);
    openPicker(h);
    expect(h.doc.querySelector("#add-popover .model-provider-heading")?.textContent).toBe("Codex");
    const rows = [...h.doc.querySelectorAll("#add-popover .model-picker-row")] as HTMLElement[];
    expect(rows.map(row => row.textContent)).toEqual(["Model A", "Model B"]);
    expect(rows[0].querySelector(".provider-codex svg")).not.toBeNull();
    click(h.window, rows[0]);
    expect(h.posted).toContainEqual({ type: "addSubagentChip", provider: "codex", model: "model-a" });
    expect(h.posted.some(msg => msg.type === "setModel")).toBe(false);
    const chips = [makeSubagentChip("codex", "model-a", "Model A"), makeSubagentChip("codex", "model-b", "Model B")];
    dispatch(h.window, { type: "chips", chips });
    const attached = [...h.doc.querySelectorAll("#attachments .attachment")];
    expect(attached).toHaveLength(2);
    expect(attached[0].textContent).toContain("Model A");
    expect(attached[0].querySelector(".provider-codex svg")).not.toBeNull();
    expect((attached[0] as HTMLElement).title).toContain("model-a");
    click(h.window, attached[0].querySelector(".attachment-remove") as HTMLElement);
    expect(h.posted).toContainEqual({ type: "removeChip", id: chips[0].id });
  });

  it("marks attached models and prevents duplicate add requests", () => {
    const h = bootWebview();
    targets(h);
    dispatch(h.window, { type: "chips", chips: [makeSubagentChip("codex", "model-a")] });
    openPicker(h);
    const row = h.doc.querySelector("#add-popover .model-picker-row") as HTMLElement;
    expect(row.classList.contains("active")).toBe(true);
    click(h.window, row);
    expect(h.posted.filter(msg => msg.type === "addSubagentChip")).toHaveLength(0);
  });

  it("explains disabled delegation and updates an open picker from fresh host targets", () => {
    const h = bootWebview();
    targets(h, "off");
    openPicker(h);
    expect(h.doc.querySelector("#add-popover .popover-fineprint")?.textContent).toContain("disabled");
    expect(h.doc.getElementById("add-popover")?.textContent).toContain("Agents & Crew settings");
    expect(h.posted).toContainEqual({ type: "refreshSubagentModels" });
    targets(h);
    expect(h.doc.querySelectorAll("#add-popover .model-picker-row")).toHaveLength(2);
  });

  it("supports arrow keys, Enter, Escape and focus return", () => {
    const h = bootWebview();
    targets(h);
    openPicker(h);
    const popover = h.doc.getElementById("add-popover") as HTMLElement;
    const key = (value: string) => popover.dispatchEvent(new (h.window as any).KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    key("ArrowDown");
    expect((h.doc.activeElement as HTMLElement).textContent).toBe("Model A");
    key("Enter");
    expect(h.posted).toContainEqual({ type: "addSubagentChip", provider: "codex", model: "model-a" });
    openPicker(h);
    key("Escape");
    expect(popover.hidden).toBe(true);
    expect(h.doc.activeElement?.id).toBe("add-btn");
  });

  it("shows model attachments in live user messages and preserves restored drafts", () => {
    const h = bootWebview();
    const chips = [makeSubagentChip("codex", "model-a", "Model A")];
    dispatch(h.window, { type: "userMessage", text: "Investigate", chips });
    expect(h.doc.querySelector(".msg-chip .provider-codex")).not.toBeNull();
    expect(h.doc.querySelector(".msg-chip")?.textContent).toBe("Model A");
    dispatch(h.window, { type: "restoreComposer", text: "Investigate", chips, draft: true });
    expect(h.doc.querySelector("#attachments .attachment")?.textContent).toContain("Model A");
  });

  it("peels the persisted directive envelope into a named model attachment", () => {
    const h = bootWebview();
    const block = renderDirectiveBlock([{ id: "d1", strength: "must", provider: "codex", model: "model-a", modelName: "Model A" }]);
    dispatch(h.window, { type: "historyReplay", active: true });
    dispatch(h.window, { type: "userMessageChunk", text: `Investigate\n\n${block}` });
    dispatch(h.window, { type: "historyReplay", active: false });
    expect(h.doc.querySelector(".msg-chip")?.textContent).toBe("Model A");
    expect(h.doc.querySelector(".msg-chip .provider-codex")).not.toBeNull();
    expect(h.doc.querySelector(".msg")?.textContent).not.toContain("companions-subagent-directives");
  });
});
