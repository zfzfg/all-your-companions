// DOM-level test for AP-04's chat action "Add as rule" — the context menu
// item that posts the user's selected chat text to the host, which then
// appends it to a rule file the user picks via a native QuickPick (host
// side: appendRuleFile in sidebar.ts, buildRuleAppend in rules-files.ts).
// The webview never picks the file and never touches disk — it only reports
// what text was selected.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

function renderAgent(window: Window, text: string): HTMLElement {
  dispatch(window, { type: "messageChunk", text });
  dispatch(window, { type: "promptComplete" });
  const msg = window.document.querySelector(".msg.agent") as HTMLElement;
  // ".body" holds the rendered text; the bubble's sibling ".msg-actions"
  // carries a timestamp that a whole-element selection would fold in too.
  return (msg.querySelector(".body") as HTMLElement) || msg;
}

function contextmenu(window: Window, el: EventTarget): MouseEvent {
  const ev = new (window as any).MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: 24, clientY: 24,
  });
  (el as Element).dispatchEvent(ev);
  return ev;
}

function selectText(window: Window, doc: Document, el: Element): void {
  const range = doc.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

function addAsRuleItem(doc: Document): HTMLButtonElement | undefined {
  return [...doc.querySelectorAll(".rail-menu-item")].find(
    (el) => el.textContent === "Add as rule",
  ) as HTMLButtonElement | undefined;
}

describe("Add as rule on the chat context menu", () => {
  it("offers Add as rule for a plain-text selection with no link", () => {
    const { window, doc } = bootWebview();
    const el = renderAgent(window, "Always run npm test before committing.");
    selectText(window, doc, el);
    const ev = contextmenu(window, el);
    expect(ev.defaultPrevented).toBe(true);
    const item = addAsRuleItem(doc);
    expect(item).toBeTruthy();
  });

  it("posts appendRuleFile with the exact selected text, and closes the menu", () => {
    const { window, doc, posted } = bootWebview();
    const el = renderAgent(window, "Always run npm test before committing.");
    selectText(window, doc, el);
    contextmenu(window, el);
    const item = addAsRuleItem(doc)!;
    click(window, item);
    const msg = posted.find((m) => m.type === "appendRuleFile");
    expect(msg).toEqual({ type: "appendRuleFile", text: "Always run npm test before committing." });
    expect(doc.querySelector(".rail-menu")).toBeNull();
  });

  it("does not appear without a text selection", () => {
    const { window, doc } = bootWebview();
    const el = renderAgent(window, "Nothing selected here.");
    const ev = contextmenu(window, el);
    expect(ev.defaultPrevented).toBe(false);
    expect(addAsRuleItem(doc)).toBeUndefined();
  });

  it("still offers Copy alongside Add as rule for a plain-text selection", () => {
    const { window, doc } = bootWebview();
    const el = renderAgent(window, "Some selectable prose.");
    selectText(window, doc, el);
    contextmenu(window, el);
    const labels = [...doc.querySelectorAll(".rail-menu-item")].map((b) => b.textContent);
    expect(labels).toContain("Copy");
    expect(labels).toContain("Add as rule");
  });
});
