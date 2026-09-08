// DOM-level test of the AP-06 limit failover card — drives the real
// media/chat.js inside happy-dom.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const OFFER = {
  type: "limitOffer" as const,
  id: "lim-1",
  kind: "quota" as const,
  source: "grok" as const,
  targets: [{ id: "claude" as const, name: "Claude" }],
  title: "Grok usage limit reached",
  text: "Usage limit reached — not a sign-in issue. This ceiling is per account.",
  recommended: "continue" as const,
  status: "failed" as const,
  durationMs: 1200,
};

describe("limit offer card (real chat.js in a DOM)", () => {
  it("renders continue / wait / dismiss and marks continue primary on a quota", () => {
    const { window, doc } = bootWebview();
    dispatch(window, OFFER);
    const card = doc.querySelector(".card.limit");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".card-title")!.textContent).toBe("Grok usage limit reached");
    const labels = [...card!.querySelectorAll(".card-actions button")].map((b) => b.textContent);
    expect(labels).toEqual(["Continue with Claude", "Wait and try again", "Dismiss"]);
    expect(card!.querySelector(".card-actions button.primary")!.textContent).toBe("Continue with Claude");
  });

  it("omits continue when no partner is connected and marks wait primary", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...OFFER, targets: [], recommended: "retry", kind: "rate", title: "Grok is rate-limited" });
    const labels = [...doc.querySelectorAll(".card.limit .card-actions button")].map((b) => b.textContent);
    expect(labels).toEqual(["Wait and try again", "Dismiss"]);
    expect(doc.querySelector(".card.limit .card-actions button.primary")!.textContent).toBe("Wait and try again");
  });

  it("Continue posts limitOfferAnswer with the target and collapses the card", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, OFFER);
    const btn = [...doc.querySelectorAll(".card.limit .card-actions button")]
      .find((b) => b.textContent === "Continue with Claude") as HTMLButtonElement;
    click(window, btn);
    expect(posted).toEqual([{ type: "limitOfferAnswer", id: "lim-1", action: "continue", target: "claude" }]);
    const card = doc.querySelector(".card.limit")!;
    expect(card.classList.contains("resolved")).toBe(true);
    expect(card.querySelector(".card-title")!.textContent).toBe("Continued with Claude");
    expect(card.querySelector(".card-actions")).toBeNull();
  });

  it("Wait posts retry without a target", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, OFFER);
    const btn = [...doc.querySelectorAll(".card.limit .card-actions button")]
      .find((b) => b.textContent === "Wait and try again") as HTMLButtonElement;
    click(window, btn);
    expect(posted).toEqual([{ type: "limitOfferAnswer", id: "lim-1", action: "retry" }]);
  });

  it("Dismiss posts dismiss and a later resolved frame is a no-op", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, OFFER);
    const btn = [...doc.querySelectorAll(".card.limit .card-actions button")]
      .find((b) => b.textContent === "Dismiss") as HTMLButtonElement;
    click(window, btn);
    expect(posted).toEqual([{ type: "limitOfferAnswer", id: "lim-1", action: "dismiss" }]);
    dispatch(window, { type: "limitOfferResolved", id: "lim-1", action: "dismiss" });
    expect(doc.querySelector(".card.limit")!.classList.contains("resolved")).toBe(true);
  });

  it("the word rate in a normal agentError does not spawn the card", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "agentError", text: "The success rate is high." });
    expect(doc.querySelector(".card.limit")).toBeNull();
    expect(doc.querySelector(".msg.error")!.textContent).toBe("The success rate is high.");
  });
});
