// clearMessages marks the transcript pending-clear instead of destroying it.
// Replacement content in the same burst drops the old nodes after the new
// ones are in (never an empty paint). No replacement → next-frame flush, and
// the welcome appears as it always did. While nodes are pending, the welcome
// stays hidden and unstamped — a resync must not paint Starting / Loading
// conversation / Connected over a conversation that is about to come back.
import { describe, it, expect } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

const raf = (window: Window) =>
  new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

const messages = (doc: Document) => doc.getElementById("messages") as HTMLElement;
const welcome = (doc: Document) => doc.getElementById("welcome") as HTMLElement;
const welcomeStatus = (doc: Document) => {
  const ver = doc.getElementById("welcome-version") as HTMLElement | null;
  return (ver?.dataset?.status || ver?.textContent || "").trim();
};
const liveMsgs = (doc: Document) =>
  [...messages(doc).children].filter(
    (el) => el.id !== "welcome" && el.getAttribute("data-pending-clear") !== "1",
  );
const visualMsgs = (doc: Document) =>
  [...messages(doc).children].filter((el) => el.id !== "welcome");
const shownText = (doc: Document) => {
  const parts: string[] = [];
  const w = welcome(doc);
  if (!w.hidden) parts.push((w.textContent || "").trim());
  for (const el of visualMsgs(doc)) {
    if ((el as HTMLElement).hidden) continue;
    parts.push((el.textContent || "").trim());
  }
  return parts.join("\n");
};
const EMPTY_STATE_STRINGS = ["Starting", "Loading conversation", "Connected"];
const showsEmptyState = (doc: Document) =>
  EMPTY_STATE_STRINGS.some((s) => shownText(doc).includes(s));

function seedConnected(window: Window) {
  dispatch(window, { type: "initialized", info: { version: "0.2.40" } });
  dispatch(window, { type: "setBusy", value: false });
}

describe("clearMessages defers destroying the transcript", () => {
  it("same-burst replacement never observes an empty transcript or an unhidden welcome", async () => {
    const { window, doc } = bootWebview();
    seedConnected(window);
    dispatch(window, { type: "userMessage", text: "hello from before" });
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("hello from before");

    let sawEmpty = false;
    let sawWelcomeUnhidden = false;
    let sawEmptyState = false;
    const obs = new window.MutationObserver(() => {
      if (visualMsgs(doc).length === 0) sawEmpty = true;
      if (!welcome(doc).hidden) sawWelcomeUnhidden = true;
      if (showsEmptyState(doc)) sawEmptyState = true;
    });
    obs.observe(messages(doc), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "data-pending-clear"],
    });

    dispatch(window, { type: "clearMessages" });
    expect(welcome(doc).hidden).toBe(true);
    expect(showsEmptyState(doc)).toBe(false);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("hello from before");
    expect(doc.querySelector(".msg.user")?.getAttribute("data-pending-clear")).toBe("1");
    expect(liveMsgs(doc)).toHaveLength(0);

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessage", text: "hello from before" });
    dispatch(window, { type: "historyReplay", active: false });
    await Promise.resolve();
    obs.disconnect();

    expect(sawEmpty).toBe(false);
    expect(sawWelcomeUnhidden).toBe(false);
    expect(sawEmptyState).toBe(false);
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("hello from before");
    expect(doc.querySelector(".msg.user")?.getAttribute("data-pending-clear")).toBeNull();
    expect(visualMsgs(doc).some((el) => el.classList.contains("user"))).toBe(true);
  });

  it("reconnect with a painted conversation never unhides the welcome", async () => {
    const { window, doc } = bootWebview();
    seedConnected(window);
    dispatch(window, { type: "onboarding", state: "provider-connected", provider: "codex" });
    dispatch(window, { type: "userMessage", text: "keep me" });
    expect(welcome(doc).hidden).toBe(true);

    let sawWelcomeUnhidden = false;
    let sawEmptyState = false;
    const obs = new window.MutationObserver(() => {
      if (!welcome(doc).hidden) sawWelcomeUnhidden = true;
      if (showsEmptyState(doc)) sawEmptyState = true;
    });
    obs.observe(messages(doc), {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["hidden", "data-pending-clear"],
    });

    dispatch(window, { type: "clearMessages" });
    expect(welcome(doc).hidden).toBe(true);
    expect(showsEmptyState(doc)).toBe(false);
    // The previous conversation is still in the tree; do not stamp empty-state
    // copy onto the hidden welcome either — a later unhide would show it.
    expect(welcomeStatus(doc)).not.toBe("Starting");
    expect(welcomeStatus(doc)).not.toBe("Loading conversation");

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "onboarding", state: "provider-connected", provider: "codex" });
    dispatch(window, { type: "initialized", info: { version: "0.2.40" } });
    dispatch(window, { type: "userMessage", text: "keep me" });
    dispatch(window, { type: "historyReplay", active: false });
    await raf(window);
    obs.disconnect();

    expect(sawWelcomeUnhidden).toBe(false);
    expect(sawEmptyState).toBe(false);
    expect(welcome(doc).hidden).toBe(true);
    expect(showsEmptyState(doc)).toBe(false);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("keep me");
  });

  it("holds the conversation across a frame while historyReplay is in flight", async () => {
    const { window, doc } = bootWebview();
    seedConnected(window);
    dispatch(window, { type: "userMessage", text: "still here" });

    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "historyReplay", active: true });
    await raf(window);
    expect(welcome(doc).hidden).toBe(true);
    expect(showsEmptyState(doc)).toBe(false);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("still here");
    expect(doc.querySelector(".msg.user")?.getAttribute("data-pending-clear")).toBe("1");

    dispatch(window, { type: "userMessage", text: "still here" });
    dispatch(window, { type: "historyReplay", active: false });
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.getAttribute("data-pending-clear")).toBeNull();
  });

  it("flushes to the welcome on the next frame when no replacement arrives", async () => {
    const { window, doc } = bootWebview();
    seedConnected(window);
    dispatch(window, { type: "sessionName", sessionId: "s1", name: "soon gone", cwd: "/work" });
    dispatch(window, { type: "userMessage", text: "soon gone" });
    expect(welcome(doc).hidden).toBe(true);
    expect(welcomeStatus(doc)).toBe("Connected · v0.2.40");
    expect((doc.getElementById("session-name-chip") as HTMLElement).hidden).toBe(false);
    expect(doc.getElementById("session-name-label")?.textContent).toBe("soon gone");
    (doc.getElementById("history-btn") as HTMLButtonElement).focus();

    dispatch(window, { type: "clearMessages" });
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("soon gone");
    expect(welcomeStatus(doc)).toBe("Connected · v0.2.40");
    expect(showsEmptyState(doc)).toBe(false);
    // Held until the flush — a resync must not blank the name first.
    expect((doc.getElementById("session-name-chip") as HTMLElement).hidden).toBe(false);
    expect(doc.activeElement).toBe(doc.getElementById("history-btn"));

    await raf(window);
    expect(doc.querySelector(".msg.user")).toBeNull();
    expect(welcome(doc).hidden).toBe(false);
    expect(welcomeStatus(doc)).toBe("Starting");
    expect((doc.getElementById("session-name-chip") as HTMLElement).hidden).toBe(true);
    expect(doc.activeElement).toBe(doc.getElementById("input"));
  });

  it("keeps the Connected onboarding confirmation across a session-swap clearMessages", async () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "onboarding", state: "provider-connected", provider: "codex" });
    const onb = doc.getElementById("welcome-onboarding")!;
    expect(onb.textContent).toContain("Connected");
    expect(onb.textContent).toContain("You can start working with OpenAI!");
    expect(welcome(doc).hidden).toBe(false);

    dispatch(window, { type: "clearMessages" });
    expect(onb.textContent).toContain("Connected");
    expect(onb.textContent).toContain("You can start working with OpenAI!");
    expect(welcome(doc).hidden).toBe(false);

    await raf(window);
    expect(doc.getElementById("welcome-onboarding")!.textContent).toContain("Connected");
    expect(welcome(doc).hidden).toBe(false);
  });

  it("no-project after clearMessages still replaces Starting with the empty-state card", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "userMessage", text: "old project chat" });
    dispatch(window, { type: "clearMessages" });
    dispatch(window, { type: "onboarding", state: "no-project" });

    expect(welcome(doc).hidden).toBe(false);
    expect(welcomeStatus(doc)).toBe("No project folder");
    expect(doc.getElementById("welcome-onboarding")!.textContent).toContain("No project folder");
    expect(doc.querySelector(".msg.user")).toBeNull();
  });

  it("a rail-transition open still shows Loading conversation, not Starting", () => {
    const withRail = (win: Window) => {
      const el = win.document.createElement("aside");
      el.id = "projects-rail";
      el.hidden = true;
      win.document.body.appendChild(el);
      const search = win.document.createElement("input");
      search.id = "rail-search";
      win.document.body.appendChild(search);
    };
    const { window, doc } = bootWebview({ beforeScripts: withRail });
    dispatch(window, {
      type: "repos",
      entries: [{ cwd: "/work/alpha", label: "alpha", available: true, pinned: false, updatedAt: 30 }],
      selectedCwd: "/work/alpha",
      activeCwd: "/work/alpha",
    });
    dispatch(window, {
      type: "sessions",
      entries: [
        { id: "a1", cwd: "/work/alpha", displayName: "alpha one", rawSummary: "", updatedAt: 9, createdAt: 1, numMessages: 2 },
        { id: "a2", cwd: "/work/alpha", displayName: "alpha two", rawSummary: "", updatedAt: 8, createdAt: 1, numMessages: 2 },
      ],
      activeId: "a1",
      dots: {},
      offset: 0,
      total: 2,
      hasMore: false,
      nextOffset: 2,
      query: "",
    });
    dispatch(window, { type: "sessionName", sessionId: "a1", name: "alpha one", cwd: "/work/alpha" });
    dispatch(window, { type: "userMessage", text: "old transcript" });

    const section = doc.querySelectorAll(".rail-repo")[0];
    click(window, section.querySelectorAll(".rail-session")[1] as HTMLElement);
    expect(welcomeStatus(doc)).toBe("Loading conversation");
    expect(welcome(doc).hidden).toBe(false);

    dispatch(window, { type: "clearMessages" });
    expect(welcomeStatus(doc)).toBe("Loading conversation");
    expect(welcomeStatus(doc)).not.toBe("Starting");
    expect(welcome(doc).hidden).toBe(false);
  });

  it("a same-conversation resync changes nothing the user can see", () => {
    // The rule, not a string: take a painted conversation, run a full
    // same-session resync burst, and observe no change — not even between
    // messages in the burst (clearMessages first, as focusSession /
    // rehydrateWebviewFromFocused).
    const snapshot = (doc: Document) => ({
      transcript: [...doc.querySelectorAll("#messages .msg .body")].map((el) => (el.textContent || "").trim()),
      welcomeHidden: welcome(doc).hidden,
      welcomeStatus: welcomeStatus(doc),
      sessionName: {
        label: doc.getElementById("session-name-label")?.textContent ?? null,
        chipHidden: (doc.getElementById("session-name-chip") as HTMLElement | null)?.hidden ?? null,
      },
      header: {
        chip: doc.getElementById("session-name-chip")?.innerHTML ?? null,
      },
      focused: (doc.activeElement as HTMLElement | null)?.id ?? null,
    });
    const replaySame = (window: Window, expectHeld: (label: string) => void) => {
      dispatch(window, {
        type: "session",
        sessionId: "keep-1",
        models: [],
        currentModelId: undefined,
      });
      expectHeld("session");
      dispatch(window, { type: "historyReplay", active: true });
      expectHeld("historyReplay start");
      dispatch(window, { type: "initialized", info: { version: "0.2.40" } });
      expectHeld("initialized");
      dispatch(window, { type: "setBusy", value: false });
      expectHeld("setBusy");
      dispatch(window, { type: "userMessage", text: "keep me" });
      expectHeld("userMessage");
      dispatch(window, { type: "historyReplay", active: false });
      expectHeld("historyReplay end");
      dispatch(window, { type: "sessionName", sessionId: "keep-1", name: "Keep this", cwd: "/work/repo" });
      expectHeld("sessionName");
    };
    const run = (opts: { name: string; prefix: (window: Window, expectHeld: (label: string) => void) => void }) => {
      const { window, doc } = bootWebview();
      seedConnected(window);
      dispatch(window, { type: "sessionName", sessionId: "keep-1", name: "Keep this", cwd: "/work/repo" });
      dispatch(window, { type: "userMessage", text: "keep me" });
      const historyBtn = doc.getElementById("history-btn") as HTMLButtonElement;
      historyBtn.focus();
      const before = snapshot(doc);
      expect(before.focused).toBe("history-btn");
      expect(before.transcript.join("\n")).toContain("keep me");
      expect(before.sessionName.label).toBe("Keep this");
      expect(before.sessionName.chipHidden).toBe(false);

      let sawWelcomeUnhidden = false;
      let sawEmptyState = false;
      const obs = new window.MutationObserver(() => {
        if (!welcome(doc).hidden) sawWelcomeUnhidden = true;
        if (showsEmptyState(doc)) sawEmptyState = true;
      });
      obs.observe(messages(doc), {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden", "data-pending-clear"],
        characterData: true,
      });
      const expectHeld = (label: string) => {
        expect(snapshot(doc), `${opts.name} after ${label}`).toEqual(before);
      };

      opts.prefix(window, expectHeld);
      replaySame(window, expectHeld);
      obs.disconnect();

      expect(snapshot(doc), `${opts.name} after resync burst`).toEqual(before);
      expect(sawWelcomeUnhidden, `${opts.name} unhid welcome`).toBe(false);
      expect(sawEmptyState, `${opts.name} empty state`).toBe(false);
    };

    run({
      name: "local",
      prefix: (window, expectHeld) => {
        dispatch(window, { type: "clearMessages" });
        expectHeld("clearMessages");
      },
    });

  });

  it("preserves scrollTop across a same-burst resync", () => {
    let scrollTop = 0;
    let scrollHeight = 400;
    const { window, doc } = bootWebview({
      beforeScripts(win) {
        const el = win.document.getElementById("messages")!;
        Object.defineProperty(el, "clientHeight", { configurable: true, get: () => 200 });
        Object.defineProperty(el, "scrollHeight", { configurable: true, get: () => scrollHeight });
        Object.defineProperty(el, "scrollTop", {
          configurable: true,
          get: () => scrollTop,
          set: (value) => { scrollTop = Number(value); },
        });
      },
    });
    dispatch(window, { type: "userMessage", text: "keep me" });
    scrollTop = 140;
    scrollHeight = 800;

    dispatch(window, { type: "clearMessages" });
    expect(scrollTop).toBe(140);

    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "userMessage", text: "keep me" });
    expect(scrollTop).toBe(140);
    dispatch(window, { type: "historyReplay", active: false });
    expect(doc.querySelector(".msg.user")?.textContent).toContain("keep me");
  });
});

describe("cold load", () => {
  it("shows Starting until the session is ready", () => {
    const { window, doc } = bootWebview({ ready: false });
    expect(welcome(doc).hidden).toBe(false);
    expect(welcomeStatus(doc)).toBe("Starting");
    dispatch(window, { type: "initialized", info: { version: "0.2.40" } });
    expect(welcome(doc).hidden).toBe(false);
    expect(welcomeStatus(doc)).toBe("Starting");
    expect(showsEmptyState(doc)).toBe(true);
  });
});

describe("pending clear", () => {
  function paintConversation(window: Window, doc: Document) {
    seedConnected(window);
    dispatch(window, { type: "sessionName", sessionId: "keep-1", name: "Keep this", cwd: "/work/repo" });
    dispatch(window, { type: "userMessage", text: "still here" });
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("still here");
  }

  it("flushes to the welcome on the next frame when nothing replaces it", async () => {
    const { window, doc } = bootWebview();
    paintConversation(window, doc);
    dispatch(window, { type: "clearMessages" });
    expect(welcome(doc).hidden).toBe(true);
    expect(doc.querySelector(".msg.user")?.textContent).toContain("still here");

    await raf(window);
    expect(doc.querySelector(".msg.user")).toBeNull();
    expect(welcome(doc).hidden).toBe(false);
    expect(welcomeStatus(doc)).toBe("Starting");
  });
});
