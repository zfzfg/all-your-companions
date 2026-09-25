// Find in the active conversation (#99). Drives the real media/chat.js.
// CSS.highlights does not exist in happy-dom — the production path must
// tolerate that (scroll + count, no <mark> wrapping). Do not stub a
// Highlight API the test environment does not have.
import { describe, it, expect, vi } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

function api(window: Window) {
  return (window as unknown as { __grokFind: FindApi }).__grokFind;
}

interface FindApi {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  query: () => string;
  setQuery: (q: string) => void;
  next: () => void;
  prev: () => void;
  matchCount: () => number;
  totalCount: () => number;
  hiddenCount: () => number;
  index: () => number;
  includeHidden: (on: boolean) => void;
  caseSensitive: () => boolean;
  setCaseSensitive: (on: boolean) => void;
  regex: () => boolean;
  setRegex: (on: boolean) => void;
  invalid: () => boolean;
  hasHighlightApi: () => boolean;
}

/**
 * Wait until the transcript has stopped growing.
 *
 * Three earlier versions of this were counted waits — one animation frame, then
 * two frames with a macrotask between — and both lose the same race for the same
 * reason: chat.js appends across an unknown number of turns of the event loop,
 * and no fixed count outruns an arbitrarily loaded machine. The symptom was a
 * file that passed in isolation and failed a DIFFERENT test in it on each full
 * run, which reads as flakiness in the feature and is really a race in the
 * harness.
 *
 * So this waits for a CONDITION instead: the node count stable across two
 * consecutive frames. That is bounded by how fast the machine actually is rather
 * than by a number somebody guessed, and it returns immediately on an idle one.
 *
 * The deadline exists so a genuine hang fails as a timeout rather than spinning
 * for the whole suite.
 */
async function flushPaint(window: Window, timeoutMs = 5_000) {
  const doc = window.document;
  const frame = () => new Promise<void>((resolve) => { window.requestAnimationFrame(() => resolve()); });
  const count = () => doc.querySelectorAll(".msg, .tool-item, .thought").length;
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  for (;;) {
    await frame();
    const now = count();
    // Two consecutive equal readings: nothing arrived during a whole frame.
    if (now === previous) return;
    previous = now;
    if (Date.now() > deadline) return; // a hang is the test's problem to report
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
}

async function playTurn(window: Window, user: string, agent: string, thought?: string) {
  dispatch(window, { type: "userMessage", text: user, chips: [] });
  dispatch(window, { type: "agentStart" });
  if (thought) dispatch(window, { type: "thoughtChunk", text: thought });
  dispatch(window, { type: "messageChunk", text: agent });
  dispatch(window, { type: "agentEnd" });
  await flushPaint(window);
}

function exec(id: string, command: string) {
  return {
    type: "toolCall" as const,
    call: {
      toolCallId: id,
      kind: "execute",
      title: `Run ${command.slice(0, 20)}`,
      rawInput: { command },
    },
  };
}

function out(command: string, output: string) {
  return {
    type: "commandOutput" as const,
    command,
    output,
    exitCode: 0,
    truncated: false,
  };
}

function key(window: Window, init: Record<string, unknown>) {
  return new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
}

function firstTextNode(root: Element): Text | null {
  const stack: ChildNode[] = [...root.childNodes];
  while (stack.length) {
    const node = stack.shift()!;
    if (node.nodeType === 3 && node.nodeValue) return node as Text;
    if (node.childNodes?.length) stack.unshift(...node.childNodes);
  }
  return null;
}

function openOverflow(window: Window, doc: Document, slotId: string) {
  const btn = doc.querySelector(`#${slotId} .rail-menu-btn`) as HTMLButtonElement | null;
  expect(btn, slotId + " ⋯").toBeTruthy();
  click(window, btn!);
  return [...doc.querySelectorAll(".rail-menu-item")].map((el) => (el.textContent || "").trim());
}

function coding(window: Window) {
  dispatch(window, {
    type: "initialState",
    effort: "",
    cwd: "/w",
    useCtrlEnter: false,
    extVersion: "0",
    showThinking: false,
    expandCommandOutputs: false,
    appPurpose: "coding",
    capabilities: {},
  });
}

describe("find in conversation (#99)", () => {
  it("does not invent a Highlight API in this environment", () => {
    const { window } = bootWebview();
    expect(api(window).hasHighlightApi()).toBe(false);
    expect((window as unknown as { CSS?: { highlights?: unknown } }).CSS?.highlights).toBeUndefined();
  });

  it("offers Find in conversation in the desktop ⋯ menu beside Export", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    const labels = openOverflow(h.window, h.doc, "session-head-actions");
    const exportAt = labels.indexOf("Export as Markdown");
    const findAt = labels.indexOf("Find in conversation");
    expect(exportAt).toBeGreaterThanOrEqual(0);
    expect(findAt).toBe(exportAt + 1);
  });

  it("offers Find in conversation in the VS Code session menu beside Export", () => {
    const h = bootWebview({ vscode: true });
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    const labels = openOverflow(h.window, h.doc, "vscode-session-actions");
    expect(labels).toEqual([
      "Continue in a new chat",
      "Export conversation as Markdown",
      "Find in conversation",
    ]);
  });

  it("matches message text and tool row labels, never the IN/OUT payload", async () => {
    // Owner call, 2026-08-19: searching inside tool/command/MCP IN-OUT bodies and
    // file-edit diffs made results chaotic — ordinary words matched dozens of
    // times in command output, burying the prose hits, and a diff hit is little
    // use when the full diff is not on screen. Labels stay searchable so "find
    // the command I ran" still works.
    const { window, doc } = bootWebview();
    coding(window);
    await playTurn(window, "please inspect unique-user-token", "unique-agent-reply");
    dispatch(window, exec("t1", "node unique-command-token.js"));
    dispatch(window, { type: "messageChunk", text: "ran it" });
    dispatch(window, out("node unique-command-token.js", "unique-output-token\nok"));

    const details = doc.querySelector(".tool-item-details") as HTMLElement;
    expect(details).toBeTruthy();
    expect(details.textContent).toContain("unique-output-token");

    api(window).open();
    api(window).setQuery("unique-user-token");
    expect(api(window).matchCount()).toBe(1);

    api(window).setQuery("unique-agent-reply");
    expect(api(window).matchCount()).toBe(1);

    // In the row's title (`Run node unique-command-`), so still findable — and
    // present in the payload too, which must NOT add a second hit.
    api(window).setQuery("unique-command-");
    expect(api(window).matchCount()).toBe(1);

    // Output body only. Not searched at all.
    api(window).setQuery("unique-output-token");
    expect(api(window).matchCount()).toBe(0);
  });

  it("counts preference-hidden thinking but excludes it from navigation", async () => {
    const { window, doc } = bootWebview();
    coding(window);
    await playTurn(window, "ask about hidden-thought-xyz", "visible-reply-xyz", "hidden-thought-xyz in the trace");
    await vi.waitFor(() => {
      expect(doc.querySelector(".thinking-body")?.textContent).toContain("hidden-thought-xyz");
    });

    expect(doc.body.classList.contains("thinking-hidden")).toBe(true);
    expect(doc.querySelector(".msg.thinking")).toBeTruthy();

    api(window).open();
    api(window).setQuery("hidden-thought-xyz");
    expect(api(window).totalCount()).toBeGreaterThanOrEqual(2);
    expect(api(window).hiddenCount()).toBeGreaterThanOrEqual(1);
    expect(api(window).matchCount()).toBe(api(window).totalCount() - api(window).hiddenCount());

    const hint = doc.querySelector(".find-hidden-hint") as HTMLButtonElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toMatch(/hidden thinking traces/);

    api(window).includeHidden(true);
    expect(api(window).matchCount()).toBe(api(window).totalCount());
  });

  it("wraps next/previous and updates the count as the query changes", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "alpha one", "alpha two alpha three");
    api(window).open();
    api(window).setQuery("alpha");
    expect(api(window).matchCount()).toBe(3);
    expect(doc.querySelector(".find-count")!.textContent).toBe("1/3");

    api(window).next();
    expect(api(window).index()).toBe(1);
    expect(doc.querySelector(".find-count")!.textContent).toBe("2/3");
    api(window).next();
    expect(api(window).index()).toBe(2);
    api(window).next();
    expect(api(window).index()).toBe(0);
    api(window).prev();
    expect(api(window).index()).toBe(2);

    api(window).setQuery("alpha t");
    expect(api(window).matchCount()).toBe(2);
    expect(doc.querySelector(".find-count")!.textContent).toMatch(/\/2$/);
  });

  it("regex mode matches and an invalid regex does not throw", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "needle-line", "done");
    await playTurn(window, "zzbuild", "ok");
    dispatch(window, exec("rx", "echo"));
    dispatch(window, out("echo", "__build\nnext"));
    api(window).open();
    api(window).setRegex(true);
    expect(() => api(window).setQuery("^needle-line$")).not.toThrow();
    expect(api(window).invalid()).toBe(false);
    expect(api(window).matchCount()).toBe(1);
    // Anchors are per text node (the `m` flag), which is what makes the
    // issue's `^_+build$` shape work at all.
    expect(() => api(window).setQuery("^z+build$")).not.toThrow();
    expect(api(window).invalid()).toBe(false);
    expect(api(window).matchCount()).toBe(1);
    // The issue's own example targeted BUILD OUTPUT. That is a payload body, so
    // it is no longer searched (owner, 2026-08-19) — a real narrowing of what
    // #99 asked for, pinned here so it cannot regress silently either way.
    api(window).setQuery("^_+build$");
    expect(api(window).matchCount()).toBe(0);

    expect(() => api(window).setQuery("(")).not.toThrow();
    expect(api(window).invalid()).toBe(true);
    expect(api(window).matchCount()).toBe(0);
    expect(doc.getElementById("find-input")!.classList.contains("find-input-invalid")).toBe(true);
    expect(doc.querySelector(".find-count")!.textContent).toBe("—");
  });

  it("Escape closes and restores focus", () => {
    const { window, doc } = bootWebview();
    const history = doc.getElementById("history-btn") as HTMLElement;
    history.focus();
    expect(doc.activeElement).toBe(history);

    api(window).open();
    expect(api(window).isOpen()).toBe(true);
    expect(doc.getElementById("find-bar")!.hidden).toBe(false);
    expect(doc.activeElement).toBe(doc.getElementById("find-input"));

    doc.getElementById("find-input")!.dispatchEvent(key(window, { key: "Escape" }));
    expect(api(window).isOpen()).toBe(false);
    expect(doc.getElementById("find-bar")!.hidden).toBe(true);
    expect(doc.activeElement).toBe(history);
  });

  it("desk/VS Code Cmd+F and the host message open find", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "hello", "world");
    const ev = key(window, { key: "f", metaKey: true });
    doc.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(api(window).isOpen()).toBe(true);

    api(window).close();
    expect(api(window).isOpen()).toBe(false);
    dispatch(window, { type: "findInSession" });
    expect(api(window).isOpen()).toBe(true);
  });

  it("reopening remembers the last query for the session", async () => {
    const { window } = bootWebview();
    await playTurn(window, "remember-me-token", "ok");
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build" });
    api(window).open();
    api(window).setQuery("remember-me-token");
    api(window).close();
    api(window).open();
    expect(api(window).query()).toBe("remember-me-token");
    expect(api(window).matchCount()).toBe(1);
  });

  it("opening with a transcript selection pre-fills that text", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "select-this-token please", "ok");
    const user = [...doc.querySelectorAll(".msg.user")].pop() as HTMLElement;
    expect(user).toBeTruthy();
    const text = firstTextNode(user);
    expect(text && text.data).toContain("select-this-token");
    const start = text!.data.indexOf("select-this-token");
    const range = doc.createRange();
    range.setStart(text!, start);
    range.setEnd(text!, start + "select-this-token".length);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    api(window).open();
    expect(api(window).query()).toBe("select-this-token");
    expect(api(window).matchCount()).toBeGreaterThanOrEqual(1);
  });

  it("does not re-arm stick-to-bottom when scrolling to a match", async () => {
    const { window, doc } = bootWebview();
    await playTurn(window, "pin-token", "later pin-token");
    const messages = doc.getElementById("messages") as HTMLElement;
    expect(messages.classList.contains("stick-to-bottom")).toBe(true);
    api(window).open();
    api(window).setQuery("pin-token");
    api(window).next();
    expect(messages.classList.contains("stick-to-bottom")).toBe(false);
  });

  it("⋯ Find in conversation opens the bar", async () => {
    const h = bootWebview();
    dispatch(h.window, { type: "sessionName", sessionId: "s1", name: "Live", cwd: "/w" });
    await playTurn(h.window, "hi", "there");
    click(h.window, h.doc.querySelector("#session-head-actions .rail-menu-btn")!);
    const item = [...h.doc.querySelectorAll(".rail-menu-item")].find((el) =>
      (el.textContent || "").includes("Find in conversation"),
    ) as HTMLElement;
    click(h.window, item);
    expect(api(h.window).isOpen()).toBe(true);
  });
});

describe("find in conversation — large transcript", () => {
  it("searches a multi-hundred-bubble transcript without throwing", async () => {
    const { window, doc } = bootWebview();
    const n = 80;
    for (let i = 0; i < n; i++) {
      dispatch(window, { type: "userMessage", text: `user line ${i} needle-${i % 7}`, chips: [] });
      dispatch(window, { type: "agentStart" });
      dispatch(window, { type: "messageChunk", text: `agent line ${i} extra needle-${i % 7}` });
      dispatch(window, { type: "agentEnd" });
    }
    await flushPaint(window);
    api(window).open();
    const t0 = Date.now();
    api(window).setQuery("needle-3");
    const ms = Date.now() - t0;
    expect(api(window).matchCount()).toBeGreaterThan(0);
    expect(doc.querySelectorAll("mark").length).toBe(0);
    expect(ms, `find over ${n * 2} bubbles took ${ms}ms`).toBeLessThan(1000);
  });
});
