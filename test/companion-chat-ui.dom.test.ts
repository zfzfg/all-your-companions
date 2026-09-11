/**
 * The companion chat surfaces after the UI rework — real chat.js in happy-dom.
 * Each test pins a behaviour the old markup did not have:
 *   1. A host notice says whether it is a warning
 *   2. The gate card shows the verify run, the findings and the providers it
 *      could not use — all three were on the wire and never painted
 *   3. The gate card is at the END of the transcript after every repaint
 *   4. A companion waiting for approval says so in words
 *   5. The session type switch answers the arrow keys
 *   6. The settings overlay receives the subagent roster and routing
 */
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const gateRun = (gate: Record<string, unknown>) => ({
  runId: "run-1",
  idea: "Ship it",
  workflowName: "idea-to-done",
  workflowTitle: "Idea to done",
  status: "at-gate",
  stages: [
    { id: "review", title: "Review", status: "done" },
    { id: "fix", title: "Fix", status: "pending" },
  ],
  currentStageId: "fix",
  gate: {
    kind: "normal",
    title: "Stage 1 done: Review",
    reason: "Review requests changes.",
    proposedNext: [{ id: "fix", title: "Fix" }],
    nextStageId: "fix",
    eligible: [{ provider: "claude", displayName: "Claude" }],
    ineligible: [],
    ...gate,
  },
});

describe("companion chat UI", () => {
  it("marks a warning notice as a warning, and an info notice as status", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "hostNotice", level: "warning", text: "Can't discard all." });
    dispatch(window, { type: "hostNotice", level: "info", text: "Rule applied." });
    const notices = [...doc.querySelectorAll(".host-notice")];
    expect(notices).toHaveLength(2);
    expect(notices[0].classList.contains("cx-notice--warning")).toBe(true);
    expect(notices[0].getAttribute("role")).toBe("alert");
    expect(notices[1].classList.contains("cx-notice--info")).toBe(true);
    expect(notices[1].getAttribute("role")).toBe("status");
  });

  it("pastes a /agent command from a notice into the prompt", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "hostNotice", level: "info", text: "Try `/agent reviewer` next." });
    click(window, doc.querySelector(".host-notice code.cx-paste")!);
    expect((doc.getElementById("input") as HTMLTextAreaElement).value).toBe("/agent reviewer ");
  });

  it("paints the verify run, the findings and the unavailable providers on the gate", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "workflowRun",
      run: gateRun({
        verify: { command: "npm test", exitCode: 1, outputTail: "1 failed" },
        verdict: "changes-requested",
        findings: [{ id: "f1", severity: "high", file: "src/a.ts", line: 4, text: "Commas are not quoted." }],
        ineligible: [{ provider: "grok", message: "Grok is not logged in." }],
      }),
    });
    const card = doc.querySelector(".workflow-gate-card")!;
    expect(card.textContent).toContain("npm test");
    expect(card.textContent).toContain("exit 1");
    expect(card.textContent).toContain("1 failed");
    expect(card.textContent).toContain("Changes requested");
    expect(card.textContent).toContain("Commas are not quoted.");
    expect(card.textContent).toContain("Grok is not logged in.");
  });

  it("opens a finding's file at its line", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "workflowRun",
      run: gateRun({ findings: [{ id: "f1", severity: "low", file: "src/a.ts", line: 4, text: "x" }] }),
    });
    click(window, doc.querySelector(".cx-finding-loc")!);
    expect(posted).toContainEqual({ type: "openFile", path: "src/a.ts:4" });
  });

  it("keeps the gate at the end of the transcript", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "workflowRun", run: gateRun({}) });
    dispatch(window, { type: "hostNotice", level: "info", text: "Something happened." });
    dispatch(window, { type: "workflowRun", run: gateRun({ title: "Stage 2 done" }) });
    const messages = doc.getElementById("messages")!;
    expect(messages.lastElementChild!.classList.contains("workflow-gate-card")).toBe(true);
    expect(doc.querySelectorAll(".workflow-gate-card")).toHaveLength(1);
  });

  it("gives the gate one primary action and a danger Cancel", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "workflowRun", run: gateRun({}) });
    const buttons = [...doc.querySelectorAll(".workflow-gate-card .gate-actions button")];
    expect(buttons.filter((b) => b.classList.contains("cx-btn--primary"))).toHaveLength(1);
    const cancel = buttons.find((b) => b.textContent === "Cancel run")!;
    expect(cancel.classList.contains("cx-btn--danger")).toBe(true);
  });

  it("says a companion is waiting for approval", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "companionSubagent",
      subagentId: "sa_9",
      label: "Schema checker",
      provider: "codex",
      providerName: "Codex",
      profile: "scoped-edit",
      profileLabel: "scoped edit",
      status: "pending-approval",
      startedAt: 1000,
      modelVerified: true,
      sameProviderAsParent: false,
    });
    expect(doc.querySelector(".companion-status")!.textContent).toContain("waiting for approval");
  });

  it("moves the session type with the arrow keys", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "agent", locked: false });
    const picker = doc.getElementById("session-type-picker")!;
    picker.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }) as unknown as Event);
    expect(posted).toContainEqual({ type: "setSessionType", sessionId: "s-1", sessionType: "crew" });
    expect(doc.getElementById("session-type-crew")!.getAttribute("aria-checked")).toBe("true");
  });

  it("hands the subagent roster and routing to the settings overlay", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "agentRoles",
      roles: [],
      flows: [],
      providers: [{ id: "gemini", label: "Gemini", connected: true, models: [] }],
      problems: [],
      cwd: "/repo",
      hasProject: true,
      workflows: [],
      subagentRoster: [{ id: "gemini", label: "Gemini", status: "usable", enabled: true, allowWrite: false, notes: "fast" }],
      subagentRouting: [{ match: ["grep"], provider: "gemini", model: "", effort: "" }],
      efforts: ["low"],
      subagentsEnabled: true,
    });
    // An empty Crew session links to the page; without a settings tab
    // (desktop, remote) that link opens the in-page overlay.
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: false });
    dispatch(window, { type: "workflowList", workflows: [], defaultWorkflow: "idea-to-done" });
    click(window, doc.querySelector("#crew-workflow-list .cx-link")!);
    const overlay = doc.getElementById("settings-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).not.toContain("Reading the roster");
    expect(overlay!.textContent).not.toContain("Reading routing rules");
    expect((overlay!.querySelector(".settings-routing-keywords") as HTMLInputElement).value).toBe("grep");
  });
});
