// AP-16 companion subagent card — real chat.js in happy-dom.
//
// `companionSubagent` is REPLACING state: the host re-sends the whole card on
// every change. These tests drive it exactly that way, and check the two things
// the card exists for — saying what the child is and what it actually did.
import { describe, it, expect } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";
import { isSubagentToolCall } from "../media/webview-helpers.js";

const card = (over: Record<string, unknown> = {}) => ({
  type: "companionSubagent",
  subagentId: "sa_1",
  label: "Auth inspector",
  provider: "gemini",
  providerName: "Google Antigravity",
  model: "m-fast",
  effort: "low",
  profile: "read-only",
  profileLabel: "read-only",
  status: "running",
  startedAt: 1_000,
  modelVerified: true,
  sameProviderAsParent: false,
  ...over,
});

const cardEl = (doc: Document) => doc.querySelector(".companion-subagent") as HTMLElement;

describe("companion subagent card (real chat.js in a DOM)", () => {
  it("draws nothing until a subagent exists", () => {
    const { doc } = bootWebview();
    expect(doc.querySelector(".companion-subagent")).toBeNull();
  });

  it("reuses the purple subagent row and names the target", () => {
    const { window, doc } = bootWebview();
    dispatch(window, card());
    const el = cardEl(doc);
    expect(el).not.toBeNull();
    // §6.11: a delegation looks like a delegation, whoever started it.
    expect(el.classList.contains("subagent-card")).toBe(true);
    const title = el.querySelector(".subagent-title")!.textContent;
    expect(title).toContain("Auth inspector");
    expect(title).toContain("Google Antigravity m-fast");
    expect(title).toContain("effort low");
    expect(el.querySelector(".companion-profile")!.textContent).toBe("read-only");
  });

  it("updates the same card rather than drawing a second one", () => {
    const { window, doc } = bootWebview();
    dispatch(window, card());
    dispatch(window, card({ status: "completed", endedAt: 21_450, summary: "17 call sites" }));
    expect(doc.querySelectorAll(".companion-subagent")).toHaveLength(1);
    expect(cardEl(doc).classList.contains("subagent-done")).toBe(true);
  });

  it("shows the duration once the child is terminal", () => {
    const { window, doc } = bootWebview();
    dispatch(window, card({ status: "completed", endedAt: 22_000, startedAt: 1_000 }));
    expect(cardEl(doc).querySelector(".subagent-time")!.textContent).toContain("21s");
  });

  describe("the notices — every host decision the agent did not ask for", () => {
    it("cautions when the child ran on the main agent's own provider", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card({ sameProviderAsParent: true }));
      expect(cardEl(doc).textContent).toContain(
        "Same provider as the main agent — not an outside opinion.",
      );
    });

    it("says when the model could not be verified", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card({ modelVerified: false }));
      expect(cardEl(doc).textContent).toContain("Model not verified (model list not loaded yet).");
    });

    it("says when the effort was lowered, and by how much", () => {
      // A silent clamp would leave the user thinking they got the effort they
      // configured on the roster.
      const { window, doc } = bootWebview();
      dispatch(window, card({ effortClamped: { requested: "max", applied: "low" } }));
      expect(cardEl(doc).textContent).toContain(
        "Effort lowered from max to low (your limit for Google Antigravity).",
      );
    });

    it("says when permissions were reduced, and why", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card({ profileDowngraded: "parent in plan mode" }));
      expect(cardEl(doc).textContent).toContain("parent in plan mode");
    });

    it("shows no notice block at all when there is nothing to explain", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card());
      expect((cardEl(doc).querySelector(".companion-notes") as HTMLElement).hidden).toBe(true);
    });
  });

  describe("the result — the host's evidence, not the child's word", () => {
    it("puts unreported files first, because that is the dangerous direction", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card({
        status: "completed",
        endedAt: 5_000,
        summary: "Refactored the token handling",
        filesObserved: ["src/auth.ts", "src/secret.ts"],
        filesReported: ["src/auth.ts"],
        unreported: ["src/secret.ts"],
      }));
      const headings = [...cardEl(doc).querySelectorAll(".companion-section-heading")]
        .map((el) => el.textContent);
      expect(headings[0]).toBe("Changed but not reported");
      expect(cardEl(doc).textContent).toContain("src/secret.ts");
    });

    it("also shows files the child claimed but the host never saw change", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card({
        status: "completed",
        endedAt: 5_000,
        claimedOnly: ["src/imagined.ts"],
      }));
      expect(cardEl(doc).textContent).toContain("Reported but not observed");
      expect(cardEl(doc).textContent).toContain("src/imagined.ts");
    });

    it("keeps the result hidden when the child produced nothing to show", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card({ status: "cancelled", endedAt: 2_000 }));
      expect((cardEl(doc).querySelector(".subagent-result") as HTMLElement).hidden).toBe(true);
    });
  });

  describe("failed and cancelled read differently", () => {
    it("marks a failure red the way a failed tool call is", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card({ status: "failed", endedAt: 3_000 }));
      expect(cardEl(doc).classList.contains("subagent-failed")).toBe(true);
      expect(cardEl(doc).querySelector(".subagent-time")!.textContent).toContain("failed");
    });

    it("marks a user cancel muted rather than red", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card({ status: "cancelled", endedAt: 3_000 }));
      expect(cardEl(doc).classList.contains("subagent-cancelled")).toBe(true);
      expect(cardEl(doc).classList.contains("subagent-failed")).toBe(false);
    });

    it("shows a refusal with its code, so the reason is not a mystery", () => {
      const { window, doc } = bootWebview();
      dispatch(window, card({ status: "refused", endedAt: 1_000, errorCode: "provider-disabled" }));
      expect(cardEl(doc).textContent).toContain("provider-disabled");
    });
  });
});

describe("P6 — origin and actions", () => {
  it("says where a delegation came from when it was not this conversation", () => {
    // A subagent started by a crew stage renders in the Crew session, so
    // without this it would look like the user's own session started it.
    const { window, doc } = bootWebview();
    dispatch(window, card({ startedBy: "Stage: review" }));
    expect(cardEl(doc).textContent).toContain("Stage: review");
  });

  it("stays quiet in the ordinary case, where saying it would be noise", () => {
    const { window, doc } = bootWebview();
    dispatch(window, card());
    expect((cardEl(doc).querySelector(".companion-origin") as HTMLElement).hidden).toBe(true);
  });

  it("offers Open transcript once the child has a session", () => {
    const { window, doc } = bootWebview();
    dispatch(window, card({ status: "completed", endedAt: 2_000, sessionId: "child-1" }));
    const labels = [...cardEl(doc).querySelectorAll(".companion-action")].map((el) => el.textContent);
    expect(labels).toContain("Open transcript");
  });

  it("offers Keep as a session only when the host says it can be promoted", () => {
    const { window, doc } = bootWebview();
    dispatch(window, card({ status: "completed", endedAt: 2_000, sessionId: "child-1" }));
    expect([...cardEl(doc).querySelectorAll(".companion-action")].map((el) => el.textContent))
      .not.toContain("Keep as a session");
    dispatch(window, card({ status: "completed", endedAt: 2_000, sessionId: "child-1", promotable: true }));
    expect([...cardEl(doc).querySelectorAll(".companion-action")].map((el) => el.textContent))
      .toContain("Keep as a session");
  });

  it("posts the promote action for this child", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, card({ status: "completed", endedAt: 2_000, sessionId: "child-1", promotable: true }));
    const promote = [...cardEl(doc).querySelectorAll(".companion-action")]
      .find((el) => el.textContent === "Keep as a session")!;
    click(window, promote);
    expect(posted).toContainEqual({
      type: "companionSubagentAction",
      subagentId: "sa_1",
      action: "promote",
    });
  });

  it("shows no action bar at all while the child is still running", () => {
    // A button that answers with a notice explaining why it does not apply is
    // worse than no button.
    const { window, doc } = bootWebview();
    dispatch(window, card());
    expect((cardEl(doc).querySelector(".companion-actions") as HTMLElement).hidden).toBe(true);
  });
});

describe("the subagent tray (§6.10 point 5)", () => {
  const tray = (doc: Document) => doc.getElementById("subagent-tray") as HTMLElement;

  it("stays hidden while nothing is delegated", () => {
    const { doc } = bootWebview();
    expect(tray(doc).hidden).toBe(true);
  });

  it("says how many the turn is waiting for, and on what", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "subagentTray",
      subagents: [
        { subagentId: "sa_1", label: "Auth inspector", provider: "gemini", providerName: "Google Antigravity", model: "m-fast", startedAt: 0 },
        { subagentId: "sa_2", label: "Test mapper", provider: "codex", providerName: "OpenAI Codex", startedAt: 0 },
      ],
    });
    expect(tray(doc).hidden).toBe(false);
    expect(doc.getElementById("subagent-tray-title")!.textContent).toBe("Waiting for 2 subagent(s)");
    expect(tray(doc).textContent).toContain("Auth inspector");
    expect(tray(doc).textContent).toContain("Google Antigravity m-fast");
  });

  it("hides itself on an empty list, which is the only 'done' signal there is", () => {
    // Replacing state: there is no separate "the tray is finished" message to
    // lose, so an empty list has to be the instruction.
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "subagentTray",
      subagents: [{ subagentId: "sa_1", label: "One", provider: "gemini", providerName: "G", startedAt: 0 }],
    });
    dispatch(window, { type: "subagentTray", subagents: [] });
    expect(tray(doc).hidden).toBe(true);
    expect(doc.getElementById("subagent-tray-list")!.textContent).toBe("");
  });

  it("cancels the child the row belongs to", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "subagentTray",
      subagents: [
        { subagentId: "sa_1", label: "One", provider: "gemini", providerName: "G", startedAt: 0 },
        { subagentId: "sa_2", label: "Two", provider: "codex", providerName: "C", startedAt: 0 },
      ],
    });
    const second = doc.querySelectorAll(".subagent-tray-row")[1];
    click(window, second.querySelector(".subagent-tray-cancel")!);
    expect(posted).toContainEqual({
      type: "companionSubagentAction",
      subagentId: "sa_2",
      action: "cancel",
    });
  });
});

describe("isSubagentToolCall and the companion tools (§6.11)", () => {
  it("cards a companion spawn, so the tool row folds into the host's card", () => {
    expect(isSubagentToolCall({ title: "companions_spawn_subagent" })).toBe(true);
  });

  it("does NOT card await or list", () => {
    // Awaiting a child that already has a card would draw a second, empty one
    // beside it; listing the roster is a lookup, not a delegation.
    expect(isSubagentToolCall({ title: "companions_await_subagents" })).toBe(false);
    expect(isSubagentToolCall({ title: "companions_list_subagent_targets" })).toBe(false);
  });

  it("still cards the providers' own native delegation tools (non-goal 4)", () => {
    expect(isSubagentToolCall({ title: "spawn_subagent" })).toBe(true);
    expect(isSubagentToolCall({ title: "Task" })).toBe(true);
  });

  it("refuses await even when the call claims a subagent kind", () => {
    expect(isSubagentToolCall({ title: "companions_await_subagents", kind: "subagent" })).toBe(false);
  });
});
