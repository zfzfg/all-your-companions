// DOM-level test of the AP-10 `/agent` result card — drives the real
// media/chat.js inside happy-dom.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const RESULT = {
  type: "agentResult" as const,
  id: "run-20260908-120000-x1-1",
  runId: "run-20260908-120000-x1",
  step: 1,
  role: "reviewer",
  provider: "claude" as const,
  providerName: "Claude",
  model: "claude-opus-5",
  effort: "high",
  mode: "agent",
  cost: "$1.23 · 4,210 tokens",
  durationMs: 42_000,
  outcome: "completed" as const,
  summary: "Checked the diff against the briefing.",
  files: ["src/a.ts", "src/b.ts"],
  open: ["the CRLF case"],
  failed: [],
  sessionId: "role-session-1",
  cwd: "/proj",
};

describe("agent result card (real chat.js in a DOM)", () => {
  it("names the role, the model it ran on, and what it cost", () => {
    const { window, doc } = bootWebview();
    dispatch(window, RESULT);
    const card = doc.querySelector(".agent-result");
    expect(card).not.toBeNull();
    expect(card!.querySelector(".card-title")!.textContent).toBe("Role reviewer finished");
    const who = card!.querySelector(".cx-card-sub")!.textContent!;
    expect(who).toContain("Claude");
    expect(who).toContain("claude-opus-5");
    expect(who).toContain("effort high");
    const meta = card!.querySelector(".card-subtitle")!.textContent!;
    expect(meta).toContain("42s");
    // The cost is the part that must never be quietly dropped — its own mark.
    expect(card!.querySelector(".agent-result-cost")!.textContent).toBe("$1.23 · 4,210 tokens");
  });

  it("shows 'no cost reported' rather than nothing when the provider reported none", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...RESULT, cost: "no cost reported" });
    expect(doc.querySelector(".agent-result .card-subtitle")!.textContent)
      .toContain("no cost reported");
  });

  it("says 'default model' when the role named none", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...RESULT, model: undefined });
    expect(doc.querySelector(".agent-result .cx-card-sub")!.textContent)
      .toContain("default model");
  });

  it("lists touched files and open items, and omits empty sections", () => {
    const { window, doc } = bootWebview();
    dispatch(window, RESULT);
    const titles = [...doc.querySelectorAll(".agent-result .agent-result-list-title")]
      .map((el) => el.textContent);
    expect(titles).toEqual(["Files touched (reported) (2)", "Still open (1)"]);
    const files = [...doc.querySelectorAll(".agent-result .agent-result-list")][0];
    expect([...files.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["src/a.ts", "src/b.ts"]);
    // Each file opens in the editor.
    expect(files.querySelectorAll("button.cx-file-link")).toHaveLength(2);
  });

  it("marks a failed run and shows the reason instead of pretending it worked", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...RESULT, outcome: "failed", summary: "", detail: "Claude could not start a session." });
    const card = doc.querySelector(".agent-result")!;
    expect(card.classList.contains("failed")).toBe(true);
    expect(card.querySelector(".card-title")!.textContent).toBe("Role reviewer failed");
    expect(card.textContent).toContain("Claude could not start a session.");
  });

  it("opens the briefing and the result by run coordinates, never by path", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, RESULT);
    const buttons = [...doc.querySelectorAll(".agent-result .cx-card-actions button")] as HTMLButtonElement[];
    // The result is what a reader came for, so it leads.
    expect(buttons.map((b) => b.textContent)).toEqual(["Open result", "Open briefing", "Open session"]);
    click(window, buttons[1]);
    click(window, buttons[0]);
    expect(posted).toEqual([
      { type: "openAgentArtifact", runId: RESULT.runId, step: 1, which: "brief" },
      { type: "openAgentArtifact", runId: RESULT.runId, step: 1, which: "result" },
    ]);
    // Nothing on the wire names a file.
    expect(JSON.stringify(posted)).not.toContain("/");
  });

  it("opens the role's own session", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, RESULT);
    const open = [...doc.querySelectorAll(".agent-result .cx-card-actions button")]
      .find((b) => b.textContent === "Open session") as HTMLButtonElement;
    click(window, open);
    expect(posted).toEqual([{ type: "resumeSession", id: "role-session-1", cwd: "/proj" }]);
  });

  it("omits Open session when the role never got a session id", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...RESULT, sessionId: undefined, outcome: "failed" });
    const labels = [...doc.querySelectorAll(".agent-result .cx-card-actions button")].map((b) => b.textContent);
    expect(labels).not.toContain("Open session");
  });

  it("survives a replay — the card is values only, so it renders the same", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, RESULT);
    dispatch(window, { type: "historyReplay", active: false });
    const cards = doc.querySelectorAll(".agent-result");
    expect(cards).toHaveLength(1);
    expect(cards[0].querySelector(".card-title")!.textContent).toBe("Role reviewer finished");
    expect(cards[0].querySelector(".card-subtitle")!.textContent).toContain("$1.23 · 4,210 tokens");
  });
});

describe("the card shows the discrepancy, not just the self-report", () => {
  it("labels the role's list as reported and highlights unreported edits", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...RESULT, files: ["src/a.ts"], open: [], unreported: ["src/secret.ts"] });
    const titles = [...doc.querySelectorAll(".agent-result .agent-result-list-title")]
      .map((el) => el.textContent);
    // The discrepancy leads, as on the subagent card: it is what the next
    // step must be told.
    expect(titles).toEqual(["Edits the role did not report (1)", "Files touched (reported) (1)"]);
    // The one row that changes what the next step should be told is the one
    // row that is coloured.
    const flagged = doc.querySelector(".agent-result .agent-result-list.unreported");
    expect(flagged).not.toBeNull();
    expect(flagged!.textContent).toContain("src/secret.ts");
  });

  it("shows reported-but-not-observed without flagging it as a warning", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...RESULT, files: ["src/a.ts"], open: [], claimedOnly: ["docs/readme.md"] });
    const titles = [...doc.querySelectorAll(".agent-result .agent-result-list-title")]
      .map((el) => el.textContent);
    expect(titles).toContain("Reported but not observed (1)");
    expect(doc.querySelector(".agent-result .agent-result-list.unreported")).toBeNull();
  });

  it("draws no discrepancy rows at all on a clean run", () => {
    const { window, doc } = bootWebview();
    dispatch(window, RESULT);
    const titles = [...doc.querySelectorAll(".agent-result .agent-result-list-title")]
      .map((el) => el.textContent);
    expect(titles.some((title) => title!.includes("did not report"))).toBe(false);
    expect(titles.some((title) => title!.includes("not observed"))).toBe(false);
  });

  it("prints the same-companion caution when there is one, and nothing when there is not", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...RESULT, caution: "This ran on Claude, the same companion as this conversation." });
    expect(doc.querySelector(".agent-result .agent-result-caution")!.textContent)
      .toContain("same companion");

    const clean = bootWebview();
    dispatch(clean.window, RESULT);
    expect(clean.doc.querySelector(".agent-result .agent-result-caution")).toBeNull();
  });
});
