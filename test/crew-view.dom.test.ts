// Crew-run panel (AP-12) — real chat.js in happy-dom.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const run = (over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  goal: "Ship AP-12",
  cwd: "/repo",
  status: "running",
  steps: [
    {
      index: 1,
      title: "Write the parser",
      role: "implementer",
      status: "done",
      sessionId: "s-impl",
      filesReported: ["src/a.ts"],
      filesObserved: ["src/a.ts"],
      durationMs: 1200,
      costUsdTicks: 1e10,
    },
    {
      index: 2,
      title: "Review the parser",
      role: "reviewer",
      status: "running",
      sessionId: "s-rev",
      filesReported: [],
      filesObserved: [],
    },
  ],
  ...over,
});

describe("crew view (real chat.js in a DOM)", () => {
  it("stays hidden until a run arrives", () => {
    const { doc } = bootWebview();
    const panel = doc.getElementById("crew-run")!;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
  });

  it("renders each step with role, status and duration, and counts the run without a dollar line", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "crewRun", run: run() });
    const panel = doc.getElementById("crew-run")!;
    expect(panel.hidden).toBe(false);
    expect(doc.getElementById("crew-run-count")!.textContent).toBe("1/2 Running");
    expect(doc.getElementById("crew-run-count")!.textContent).not.toMatch(/\$/);
    const items = [...doc.querySelectorAll("#crew-run-list .crew-step")];
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toMatch(/implementer/);
    expect(items[0].textContent).toMatch(/done/);
    expect(items[0].textContent).toMatch(/1\.2s/);
    expect(items[0].textContent).not.toMatch(/\$/);
    expect(items[1].textContent).toMatch(/reviewer/);
  });

  it("clicking a step posts openCrewSession with that step's session id", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "crewRun", run: run() });
    click(window, doc.querySelector(".crew-step-open")!);
    expect(posted.some((m) => m.type === "openCrewSession" && m.sessionId === "s-impl")).toBe(true);
  });

  it("Stop posts stopCrew", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "crewRun", run: run() });
    // Stop asks twice — it holds the whole run, not one step.
    click(window, doc.getElementById("crew-run-stop")!);
    expect(posted.some((m) => m.type === "stopCrew")).toBe(false);
    click(window, doc.getElementById("crew-run-stop")!);
    expect(posted.some((m) => m.type === "stopCrew")).toBe(true);
  });

  it("survives a focus switch: clearMessages then crewRun snapshot puts it back", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "crewRun", run: run() });
    dispatch(window, { type: "clearMessages" });
    expect(doc.getElementById("crew-run")!.hidden).toBe(true);
    dispatch(window, { type: "crewRun", run: run({ status: "done" }) });
    expect(doc.getElementById("crew-run")!.hidden).toBe(false);
    expect(doc.querySelectorAll("#crew-run-list .crew-step")).toHaveLength(2);
  });

  it("null run hides the panel rather than painting a blank card", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "crewRun", run: run() });
    dispatch(window, { type: "crewRun", run: null });
    expect(doc.getElementById("crew-run")!.hidden).toBe(true);
  });
});
