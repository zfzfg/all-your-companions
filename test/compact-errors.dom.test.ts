import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

describe("compact errors", () => {
  it("keeps a large tool failure inside collapsed details and preserves expansion on updates", () => {
    const h = bootWebview();
    const message = "Command failed\n" + "source code line\n".repeat(3000);
    dispatch(h.window, { type: "toolCall", call: { toolCallId: "bad", kind: "execute", title: "Run command", rawInput: { command: "test" } } });
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "bad", status: "failed", rawOutput: { message } } });
    const row = h.doc.querySelector(".tool-failed")!;
    const details = row.querySelector<HTMLElement>(".tool-item-details")!;
    expect(details.hidden).toBe(true);
    expect(details.querySelector(".tool-error")!.textContent).toBe(message.trim());
    expect(row.querySelector(".tool-error-summary")!.textContent).toBe("Command failed");
    click(h.window, row);
    expect(details.hidden).toBe(false);
    dispatch(h.window, { type: "toolCallUpdate", call: { toolCallId: "bad", status: "failed", rawOutput: { message: message + "updated" } } });
    expect(details.hidden).toBe(false);
    expect(details.querySelector(".tool-error")!.textContent).toContain("updated");
  });
  it("folds standalone long session errors without losing the full message or code", () => {
    const h = bootWebview(), text = "Connection failed\n" + "details\n".repeat(2000);
    dispatch(h.window, { type: "error", text, code: "network" });
    const row = h.doc.querySelector(".msg.error")!;
    const details = row.querySelector("details")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("pre")!.textContent).toBe(text);
    expect(row.getAttribute("data-error-code")).toBe("network");
  });
});
