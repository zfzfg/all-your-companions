// DOM-level test of the permission card's diff-preview UX (issue #21) — drives
// the REAL shipped media/chat.js in a happy-dom window. It seeds the edit diff
// (via the toolCallUpdate the host posts), renders the permission card, and
// asserts the webview now:
//   - auto-opens the diff (posts `openDiff`) the moment the card appears,
//   - carries the `requestId` on both `openDiff` and `permissionAnswer` so the
//     host can pair the auto-opened tab with the answer and close it,
//   - still offers a manual "open diff →" button to re-open it.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const DIFF = { type: "diff", path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" };

function seedDiffAndCard(window: any, requestId: number | string = 7) {
  // The host posts the edit content as a toolCallUpdate; chat.js stashes it in
  // pendingDiffByToolCallId keyed by toolCallId.
  dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
  dispatch(window, {
    type: "permissionRequest",
    req: {
      id: requestId,
      toolCall: { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "rej", name: "Reject", kind: "reject_once" },
      ],
    },
  });
}

describe("permission card diff preview (real chat.js in a DOM)", () => {
  it("updates an existing card's options when Plan mode changes", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 77,
        toolCall: { toolCallId: "tc-mode", kind: "execute", title: "Run a command" },
        options: [
          { optionId: "once", name: "Allow once", kind: "allow_once" },
          { optionId: "always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    dispatch(window, {
      type: "permissionOptions",
      requestId: 77,
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    expect([...doc.querySelectorAll(".card.permission .card-actions button")]
      .map((button) => button.textContent)).toEqual(["Allow once", "Reject"]);

    dispatch(window, {
      type: "permissionOptions",
      requestId: 77,
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "always", name: "Allow always", kind: "allow_always" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const buttons = [...doc.querySelectorAll(".card.permission .card-actions button")] as HTMLButtonElement[];
    expect(buttons.map((button) => button.textContent))
      .toEqual(["Allow once", "Allow always", "Reject"]);

    buttons[1].click();
    expect(posted).toContainEqual({
      type: "permissionAnswer",
      requestId: 77,
      optionId: "always",
    });
  });

  it("auto-opens the diff with the file content and requestId when the card appears", () => {
    const { window, posted, doc } = bootWebview();
    seedDiffAndCard(window, 7);

    const card = doc.querySelector(".card.permission");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".card-subtitle")!.textContent).toContain("src/foo.ts");

    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(1);
    expect(openDiffs[0]).toEqual({
      type: "openDiff",
      path: "src/foo.ts",
      oldText: "a\nb",
      newText: "a\nB\nc",
      requestId: 7,
    });
  });

  it("does NOT auto-open again when the same card is re-rendered (#132)", () => {
    // The reported bug: close the proposed diff, switch conversations, come
    // back, and it reopens — on top of the files you were actually working in.
    // Re-entering a chat rebuilds its pending cards from the transcript, and
    // that rebuild was firing auto-open a second time. A card being redrawn is
    // not the card arriving.
    const { window, posted, doc } = bootWebview();
    seedDiffAndCard(window, 11);
    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(1);

    // The same permission arriving again, exactly as a transcript replay
    // delivers it.
    seedDiffAndCard(window, 11);

    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(1);
    // The card is still there and still offers the manual control — the fix
    // removes the surprise, not the ability to look.
    const btn = doc.querySelector(".card.permission .preview-link") as HTMLButtonElement;
    expect(btn).not.toBeNull();
  });

  it("still auto-opens a DIFFERENT request, because that is a new proposal", () => {
    // The dedupe must be per request, not a one-shot for the whole window: a
    // fresh edit is a fresh thing to look at.
    const { window, posted } = bootWebview();
    seedDiffAndCard(window, 21);
    seedDiffAndCard(window, 22);

    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(2);
    expect(openDiffs.map((m: any) => m.requestId)).toEqual([21, 22]);
  });

  it("keeps a manual 'open diff' button that re-opens the same diff", () => {
    const { window, posted, doc } = bootWebview();
    seedDiffAndCard(window, 9);

    const btn = doc.querySelector(".card.permission .preview-link") as HTMLButtonElement;
    expect(btn).not.toBeNull();
    expect(btn.textContent).toContain("open diff");
    click(window, btn);

    const openDiffs = posted.filter((m: any) => m.type === "openDiff");
    expect(openDiffs).toHaveLength(2); // auto-open + the manual re-open
    expect(openDiffs[1].requestId).toBe(9);
  });

  it("answering carries the same requestId so the host can close the auto-opened tab", () => {
    const { window, posted, doc } = bootWebview();
    seedDiffAndCard(window, 11);

    const allow = [...doc.querySelectorAll(".card.permission .card-actions button")]
      .find((b) => b.textContent === "Allow once") as HTMLButtonElement;
    click(window, allow);

    const answer = posted.find((m: any) => m.type === "permissionAnswer");
    expect(answer).toEqual({ type: "permissionAnswer", requestId: 11, optionId: "allow" });
  });

  it("does not auto-open when the permission has no diff (e.g. a command)", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 12,
        toolCall: { toolCallId: "tc-exec", kind: "execute", title: "Run npm test" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      },
    });

    expect(doc.querySelector(".card.permission")).not.toBeNull();
    expect(doc.querySelector(".card.permission .preview-link")).toBeNull();
    expect(posted.filter((m: any) => m.type === "openDiff")).toHaveLength(0);
  });

  it("clips a long permission command and keeps its View all path", () => {
    const { window, doc } = bootWebview({
      beforeScripts: (win) => {
        Object.defineProperty(win.HTMLElement.prototype, "clientWidth", {
          configurable: true,
          get() { return this.classList?.contains("command-card-title") ? 120 : 0; },
        });
        Object.defineProperty(win.HTMLElement.prototype, "clientHeight", {
          configurable: true,
          get() { return this.classList?.contains("command-card-title") ? 52 : 0; },
        });
        Object.defineProperty(win.HTMLElement.prototype, "scrollHeight", {
          configurable: true,
          get() { return this.classList?.contains("command-card-title") ? 208 : 0; },
        });
      },
    });
    const command = `python -c "${"print('x');".repeat(300)}"`;
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 13,
        toolCall: { toolCallId: "tc-long", kind: "execute", title: command },
        options: [
          { optionId: "allow", name: "Allow once", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });

    const card = doc.querySelector(".card.permission")!;
    const title = card.querySelector(".command-card-title") as HTMLElement;
    expect(title.textContent).toBe(command);
    expect(title.title).toBe(command);
    expect(title.tagName).toBe("PRE");
    expect(title.classList.contains("command-preview-capped")).toBe(true);
    expect(card.querySelector(".command-view-all")!.textContent).toBe("View all (1 lines) →");
    expect(card.querySelectorAll(".card-actions button")).toHaveLength(2);
  });
});
