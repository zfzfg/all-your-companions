// AP-15 Session type control — real chat.js in happy-dom.
//
// The host is the authority on the lock (§5.6), so these tests drive the
// webview only through `sessionType` messages and assert what it draws and
// what it posts back. Nothing here decides that a session is locked.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const picker = (doc: Document) => doc.getElementById("session-type-picker")!;
const badge = (doc: Document) => doc.getElementById("session-type-badge")!;

describe("session type control (real chat.js in a DOM)", () => {
  it("stays hidden until the host says what this session is", () => {
    const { doc } = bootWebview();
    expect(picker(doc).hidden).toBe(true);
    expect(badge(doc).hidden).toBe(true);
  });

  it("shows the segmented switch, selecting the type the host reported", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "", sessionType: "crew", locked: false });
    expect(picker(doc).hidden).toBe(false);
    expect(badge(doc).hidden).toBe(true);
    const crew = doc.getElementById("session-type-crew")!;
    const agent = doc.getElementById("session-type-agent")!;
    expect(crew.classList.contains("selected")).toBe(true);
    expect(crew.getAttribute("aria-checked")).toBe("true");
    expect(agent.classList.contains("selected")).toBe(false);
    expect(agent.getAttribute("aria-checked")).toBe("false");
  });

  it("posts setSessionType when the other option is clicked", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "agent", locked: false });
    click(window, doc.getElementById("session-type-crew")!);
    expect(posted).toContainEqual({ type: "setSessionType", sessionId: "s-1", sessionType: "crew" });
  });

  it("does not post when the already-selected option is clicked", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "agent", locked: false });
    click(window, doc.getElementById("session-type-agent")!);
    expect(posted.filter((m) => m.type === "setSessionType")).toHaveLength(0);
  });

  it("replaces the switch with a locked badge carrying the copy-deck tooltip", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: true });
    expect(picker(doc).hidden).toBe(true);
    expect(badge(doc).hidden).toBe(false);
    expect(badge(doc).textContent).toBe("Crew");
    expect(badge(doc).getAttribute("title")).toBe(
      "This session is locked to Crew mode. Start a new session to use Agent.",
    );
  });

  it("uses the Agent wording for a locked Agent session", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "agent", locked: true });
    expect(badge(doc).textContent).toBe("Agent");
    expect(badge(doc).getAttribute("title")).toBe(
      "This session is locked to Agent mode. Start a new session to use Crew.",
    );
  });

  it("sends nothing once locked, even if a click reaches the hidden switch", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "agent", locked: true });
    click(window, doc.getElementById("session-type-crew")!);
    expect(posted.filter((m) => m.type === "setSessionType")).toHaveLength(0);
  });

  it("corrects itself when the host refuses a switch", () => {
    // The webview flips optimistically; the host's answer is the truth.
    const { window, doc } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "agent", locked: false });
    click(window, doc.getElementById("session-type-crew")!);
    expect(doc.getElementById("session-type-crew")!.classList.contains("selected")).toBe(true);
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "agent", locked: true });
    expect(badge(doc).textContent).toBe("Agent");
  });

  it("makes the Crew composer ask for an idea, and Agent's ask for a message", () => {
    const { window, doc } = bootWebview();
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    dispatch(window, { type: "sessionType", sessionId: "", sessionType: "crew", locked: false });
    expect(input.placeholder).toBe("Describe your idea — the crew takes it from here.");
    dispatch(window, { type: "sessionType", sessionId: "", sessionType: "agent", locked: false });
    expect(input.placeholder).not.toBe("Describe your idea — the crew takes it from here.");
  });

  it("keeps the permission-mode picker a separate control", () => {
    // D1 / §3: the Agent/Plan/Auto-accept button is a different axis and must
    // not be touched by a session-type message.
    const { window, doc } = bootWebview();
    dispatch(window, { type: "modeChanged", modeId: "plan" });
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: false });
    const modeBtn = doc.getElementById("mode-btn");
    if (modeBtn) expect(modeBtn.textContent).not.toMatch(/Crew/);
    expect(picker(doc).hidden).toBe(false);
  });
});
