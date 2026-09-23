import { describe, expect, it, vi } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

describe("host confirmation resolution", () => {
  it("ignores a destructive request replayed by an older host", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "uiConfirmRequest", id: "old", title: "Revert?", confirmLabel: "Rewind" });
    expect(doc.querySelector(".confirm-overlay")).toBeNull();
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".confirm-overlay")).toBeNull();
  });

  it("dismisses only the matching modal, removes its key handler and suppresses a second answer", async () => {
    const { window, doc, posted } = bootWebview();
    const removed = vi.spyOn(doc, "removeEventListener");
    for (const id of ["first", "second"]) {
      dispatch(window, { type: "uiConfirmRequest", id, title: id, confirmLabel: "Rewind", danger: true });
    }
    dispatch(window, { type: "uiConfirmResolved", requestId: "unrelated" });
    expect(doc.querySelectorAll(".confirm-overlay")).toHaveLength(2);
    dispatch(window, { type: "uiConfirmResolved", requestId: "first" });
    dispatch(window, { type: "uiConfirmResolved", requestId: "first" });
    await Promise.resolve();
    expect(doc.querySelectorAll(".confirm-overlay")).toHaveLength(1);
    expect(doc.querySelector(".confirm-title")!.textContent).toBe("second");
    expect(removed.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    expect(posted.filter((m: any) => m.type === "uiConfirmAnswer")).toEqual([]);
    doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await Promise.resolve();
    expect(posted.filter((m: any) => m.type === "uiConfirmAnswer")).toEqual([{ type: "uiConfirmAnswer", id: "second", ok: false }]);
    expect(doc.body.dataset.modalAbove).toBeUndefined();
  });

  it("a local click settles once, even when the resolution follows immediately", async () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "uiConfirmRequest", id: "one", title: "Rewind?", confirmLabel: "Rewind" });
    click(window, doc.querySelector(".confirm-primary")!);
    dispatch(window, { type: "uiConfirmResolved", requestId: "one" });
    await Promise.resolve();
    expect(posted.filter((m: any) => m.type === "uiConfirmAnswer")).toEqual([{ type: "uiConfirmAnswer", id: "one", ok: true }]);
    expect(doc.querySelector(".confirm-overlay")).toBeNull();
  });

  it("session replacement cannot send an old modal's decision to the new session", async () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "uiConfirmRequest", id: "one", title: "Rewind?", confirmLabel: "Rewind" });
    dispatch(window, { type: "clearMessages" });
    await Promise.resolve();
    expect(doc.querySelector(".confirm-overlay")).toBeNull();
    expect(posted.filter((m: any) => m.type === "uiConfirmAnswer")).toEqual([]);
  });
});
