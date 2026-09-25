/**
 * What a signed-out agent looks like in the real webview.
 *
 * Driven through the shipped `media/chat.js` so the assertions are about the
 * rendered popover, not about the intent behind it: the picker must never offer
 * a row that reads as a selectable model for an account that cannot answer, and
 * the Accounts cluster must offer signing in rather than signing out of
 * credentials that are already being refused.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch, type Posted } from "./webview-harness";

const $ = (doc: Document, id: string) => doc.getElementById(id) as HTMLElement;
const modelBtn = (doc: Document) => doc.querySelector(".model-name-btn") as HTMLButtonElement;
const popoverText = (doc: Document) => doc.getElementById("gear-popover")!.textContent || "";
const items = (doc: Document) => [...doc.querySelectorAll("#gear-popover .toolbar-popover-item")];
const types = (posted: Posted[]) => posted.map((p) => p.type);

function bootSignedOutCodex() {
  const h = bootWebview();
  dispatch(h.window, {
    type: "providerState",
    providers: [{ id: "codex", connected: true, needsLogin: true }],
  });
  dispatch(h.window, {
    type: "session",
    sessionId: "s1",
    provider: "codex",
    currentModelId: "gpt-5.6-sol",
    models: [
      // A model remembered from when the account still worked, plus the
      // synthesized default-model placeholder the field report showed. Neither
      // is something this account can honour right now.
      { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      { provider: "codex", modelId: "", name: "Codex default", defaultImplied: true },
    ],
  });
  h.posted.length = 0;
  return h;
}

// "Not connected => Not visible" (owner, 2026-08-17). A provider that cannot
// answer is absent from the picker entirely — no models, no heading, no
// sign-in row. It used to put an agent you cannot choose in the middle of the
// menu for choosing one. Manage providers at the bottom is the single way back,
// for every provider.
describe("model picker for an agent that needs a sign-in", () => {
  it("locks the selector when nothing can answer, rather than opening an unusable list", () => {
    // Signed-out Codex is the only provider here, so there is nothing to choose
    // between and the picker does not open at all (owner, 2026-08-17: "when no
    // provider is available disable model selector"). The omission of a
    // signed-out provider FROM a list is covered by the next test, where another
    // agent is healthy and the list therefore exists.
    const h = bootSignedOutCodex();
    click(h.window, $(h.doc, "gear-btn"));
    expect(modelBtn(h.doc).className).toContain("disabled");

    click(h.window, modelBtn(h.doc));
    expect(popoverText(h.doc)).not.toContain("Sign in to load models");
  });

  it("keeps a healthy agent's models and drops the signed-out one's heading", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [
        { id: "grok", connected: true },
        { id: "codex", connected: true, needsLogin: true },
      ],
    });
    dispatch(h.window, {
      type: "session",
      sessionId: "fresh",
      provider: "grok",
      currentModelId: "grok-build",
      models: [
        { provider: "grok", modelId: "grok-build", name: "Grok Build" },
        { provider: "codex", modelId: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
      ],
    });
    click(h.window, $(h.doc, "gear-btn"));
    click(h.window, modelBtn(h.doc));

    expect(popoverText(h.doc)).toContain("Grok Build");
    expect(popoverText(h.doc)).not.toContain("GPT-5.6 Sol");
    // Codex contributes nothing at all now, so its heading goes with its rows.
    expect([...h.doc.querySelectorAll(".model-provider-heading")].map((el) => el.textContent))
      .toEqual(["Grok"]);
    expect(popoverText(h.doc)).not.toContain("Sign in to load models");
  });
});

describe("the Accounts cluster for an agent that needs a sign-in", () => {
  // The verb is Connect, same as a provider that was never linked. "Sign in
  // again" described OUR bookkeeping — linked once, credentials lapsed — and to
  // the user both rows meant the same thing: this one does not work, press here.
  // Owner's call, 2026-08-17. The row keeps its warning styling, so the stale
  // state is still visible without a second word for one action.
  it("offers Connect, not signing out, and never says Sign in again", () => {
    const h = bootSignedOutCodex();
    click(h.window, $(h.doc, "gear-btn"));

    expect(popoverText(h.doc)).toContain("Connect");
    expect(popoverText(h.doc)).not.toContain("Sign in again");
    expect(popoverText(h.doc)).not.toContain("Sign out");
    const row = items(h.doc).find((el) => el.textContent?.includes("Connect")) as HTMLElement;
    click(h.window, row);
    expect(h.posted).toContainEqual({ type: "runGrokLogin", provider: "codex" });
    expect(types(h.posted)).not.toContain("logout");
  });

  it("keeps sign-out for a healthy account in Settings, not the gear", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "providerState",
      providers: [{ id: "codex", connected: true }],
    });
    click(h.window, $(h.doc, "gear-btn"));
    expect(popoverText(h.doc)).not.toContain("Sign out");
    const settings = items(h.doc).find((el) =>
      /(^|\s)Settings$/.test((el.textContent || "").replace(/\s+/g, " ").trim()),
    );
    click(h.window, settings!);
    const providers = [...h.doc.querySelectorAll("#settings-overlay .settings-nav-item")]
      .find((el) => (el.textContent || "").trim() === "Providers")!;
    click(h.window, providers);
    expect(h.doc.querySelector('[data-id="providerCodex"]')!.textContent).toContain("Sign out");
    expect(h.doc.querySelector('[data-id="providerCodex"]')!.textContent).not.toContain("Connect");
  });
});
