// DOM regression for the in-app preview overlay (desktop previewInApp).
// Drives the real media/chat.js View-all / proposed-diff entry points.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootWebview, click, dispatch } from "./webview-harness";

const highlightSrc = readFileSync(
  fileURLToPath(new URL("../media/syntax-highlight.js", import.meta.url)),
  "utf8",
);

const LONG_CMD = Array.from({ length: 8 }, (_, i) =>
  i === 0 ? 'function Get-Status { Write-Output "probe" }' : `Write-Output "line ${i + 1}"`,
).join("\n");
const LONG_OUT = Array.from({ length: 9 }, (_, i) => `output ${i + 1}`).join("\n");
const DIFF = { type: "diff", path: "src/foo.ts", oldText: "a\nb", newText: "a\nB\nc" };

function exec(id: string, command: string) {
  return {
    type: "toolCall",
    call: {
      toolCallId: id,
      kind: "execute",
      title: `Run ${command.slice(0, 20)}…`,
      rawInput: { variant: "Bash", command, is_background: false },
    },
  };
}

function out(command: string, output: string) {
  return { type: "commandOutput", command, output, exitCode: 0, truncated: false };
}

function bootPreview(opts: { preview?: boolean; commandLanguage?: string } = {}) {
  const h = bootWebview({
    beforeScripts: (window) => {
      (window as unknown as { eval: (src: string) => void }).eval(highlightSrc);
    },
  });
  dispatch(h.window, {
    type: "initialState",
    effort: "",
    cwd: "/w",
    useCtrlEnter: false,
    extVersion: "0",
    showThinking: false,
    expandCommandOutputs: true,
    commandLanguage: opts.commandLanguage || "powershell",
    capabilities: opts.preview === false ? {} : { previewInApp: true },
  });
  return h;
}

function mockClipboard(window: Window): { value: string } {
  const box = { value: "" };
  Object.defineProperty((window as unknown as { navigator: Navigator }).navigator, "clipboard", {
    value: { writeText: (t: string) => { box.value = t; return Promise.resolve(); } },
    configurable: true,
  });
  return box;
}

function openLongCommand(window: Window) {
  dispatch(window, exec("preview-cmd", LONG_CMD));
  dispatch(window, { type: "messageChunk", text: "done" });
  dispatch(window, out(LONG_CMD, LONG_OUT));
}

function viewAllButtons(doc: Document): HTMLButtonElement[] {
  return [...doc.querySelectorAll(".command-view-all")] as HTMLButtonElement[];
}

describe("preview overlay — View all", () => {
  it("posts openText when the host does not advertise previewInApp", () => {
    const { window, doc, posted } = bootPreview({ preview: false });
    openLongCommand(window);
    const buttons = viewAllButtons(doc);
    expect(buttons.length).toBeGreaterThan(0);
    click(window, buttons[0]);
    expect(doc.getElementById("preview-overlay")).toBeNull();
    expect(posted.filter((m) => m.type === "openText")).toEqual([
      { type: "openText", content: LONG_CMD, language: "powershell" },
    ]);
  });

  it("opens a highlighted overlay and does not post openText when previewInApp is set", () => {
    const { window, doc, posted } = bootPreview();
    openLongCommand(window);
    click(window, viewAllButtons(doc)[0]);
    const overlay = doc.getElementById("preview-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay!.querySelector(".preview-title")!.textContent).toBe("Untitled (powershell)");
    expect(overlay!.querySelector(".preview-lang")!.textContent).toBe("powershell");
    expect(overlay!.querySelectorAll(".hl-kw").length).toBeGreaterThan(0);
    expect(overlay!.textContent).toContain("Get-Status");
    expect(overlay!.querySelector(".tdl")).toBeNull();
    expect(overlay!.querySelector(".preview-open-panel")).toBeNull();
    expect(posted.filter((m) => m.type === "openText")).toHaveLength(0);
    expect(posted.filter((m) => m.type === "readProjectFile")).toHaveLength(0);
  });

  it("closes on Escape", () => {
    const { window, doc } = bootPreview();
    openLongCommand(window);
    click(window, viewAllButtons(doc)[0]);
    expect(doc.getElementById("preview-overlay")).toBeTruthy();
    doc.dispatchEvent(new (window as unknown as { KeyboardEvent: typeof KeyboardEvent }).KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
    }));
    expect(doc.getElementById("preview-overlay")).toBeNull();
  });

  it("Copy writes the raw text and Save As posts filename-bearing openText", async () => {
    const { window, doc, posted } = bootPreview();
    const clip = mockClipboard(window);
    openLongCommand(window);
    click(window, viewAllButtons(doc)[0]);
    const overlay = doc.getElementById("preview-overlay")!;
    const copy = [...overlay.querySelectorAll(".preview-action-btn")]
      .find((el) => el.textContent === "Copy") as HTMLButtonElement;
    const save = [...overlay.querySelectorAll(".preview-action-btn")]
      .find((el) => el.textContent === "Save As") as HTMLButtonElement;
    click(window, copy);
    await Promise.resolve();
    expect(clip.value).toBe(LONG_CMD);
    click(window, save);
    expect(posted.filter((m) => m.type === "openText")).toEqual([
      { type: "openText", content: LONG_CMD, filename: "Untitled.ps1", language: "powershell" },
    ]);
  });
});

describe("preview overlay — proposed diffs", () => {
  function seedEdit(window: Window) {
    dispatch(window, {
      type: "toolCall",
      call: { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" },
    });
    dispatch(window, {
      type: "toolCallUpdate",
      call: { toolCallId: "tc1", kind: "edit", content: [DIFF] },
    });
    dispatch(window, { type: "messageChunk", text: "done" });
  }

  it("posts openDiff when the host does not advertise previewInApp", () => {
    const { window, doc, posted } = bootPreview({ preview: false });
    seedEdit(window);
    const link = doc.querySelector(".tool-item-diff .preview-link") as HTMLButtonElement;
    expect(link).toBeTruthy();
    click(window, link);
    expect(doc.getElementById("preview-overlay")).toBeNull();
    expect(posted.filter((m) => m.type === "openDiff")).toHaveLength(1);
    expect(posted.find((m) => m.type === "openDiff")).toMatchObject({
      type: "openDiff",
      path: "src/foo.ts",
      oldText: "a\nb",
      newText: "a\nB\nc",
    });
  });

  it("opens a full-size overlay and does not post openDiff when previewInApp is set", () => {
    const { window, doc, posted } = bootPreview();
    seedEdit(window);
    click(window, doc.querySelector(".tool-item-diff .preview-link") as HTMLButtonElement);
    const overlay = doc.getElementById("preview-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay!.querySelector(".preview-title")!.textContent).toBe("foo.ts");
    expect(overlay!.querySelector(".tool-diff-region")).toBeTruthy();
    expect(overlay!.querySelectorAll(".tdl").length).toBeGreaterThan(0);
    expect(overlay!.querySelector(".tool-diff-toggle")).toBeNull();
    expect(posted.filter((m) => m.type === "openDiff")).toHaveLength(0);
  });

  it("does not auto-open the overlay on a permission card", () => {
    const { window, doc, posted } = bootPreview();
    dispatch(window, { type: "toolCallUpdate", call: { toolCallId: "tc1", content: [DIFF] } });
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 7,
        toolCall: { toolCallId: "tc1", kind: "edit", title: "Edit src/foo.ts" },
        options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }],
      },
    });
    expect(doc.getElementById("preview-overlay")).toBeNull();
    expect(posted.filter((m) => m.type === "openDiff")).toHaveLength(0);
    click(window, doc.querySelector(".card.permission .preview-link") as HTMLButtonElement);
    expect(doc.getElementById("preview-overlay")).toBeTruthy();
    expect(posted.filter((m) => m.type === "openDiff")).toHaveLength(0);
  });

  it("Save As posts a unified diff through the existing openText filename path", () => {
    const { window, doc, posted } = bootPreview();
    seedEdit(window);
    click(window, doc.querySelector(".tool-item-diff .preview-link") as HTMLButtonElement);
    const save = [...doc.querySelectorAll("#preview-overlay .preview-action-btn")]
      .find((el) => el.textContent === "Save As") as HTMLButtonElement;
    click(window, save);
    const sent = posted.filter((m) => m.type === "openText");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "openText",
      filename: "foo.ts.diff",
      language: "diff",
    });
    expect(String(sent[0].content)).toContain("--- src/foo.ts");
    expect(String(sent[0].content)).toContain("+B");
  });

  it("Open in file panel calls openPath with the diff's relPath and closes the overlay", () => {
    const { window, doc } = bootPreview();
    const opened: string[] = [];
    (window as unknown as { __grokDeskFilePanel: { openPath: (p: string) => void } }).__grokDeskFilePanel = {
      openPath: (p) => { opened.push(p); },
    };
    seedEdit(window);
    click(window, doc.querySelector(".tool-item-diff .preview-link") as HTMLButtonElement);
    const overlay = doc.getElementById("preview-overlay")!;
    const panelBtn = [...overlay.querySelectorAll(".preview-action-btn")]
      .find((el) => el.textContent === "Open in file panel") as HTMLButtonElement;
    expect(panelBtn).toBeTruthy();
    click(window, panelBtn);
    expect(doc.getElementById("preview-overlay")).toBeNull();
    expect(opened).toEqual(["src/foo.ts"]);
  });
});

const readCall = (id: string, input: Record<string, unknown>) => ({
  type: "toolCall",
  call: { toolCallId: id, kind: "read", title: "read_file", rawInput: input },
});
const readDone = (id: string, text: string, extra?: Record<string, unknown>) => ({
  type: "toolCallUpdate",
  call: {
    toolCallId: id,
    status: "completed",
    content: [{ type: "content", content: { type: "text", text } }],
    ...(extra ? { rawOutput: extra } : {}),
  },
});
const closeTurn = (window: Window) => dispatch(window, { type: "messageChunk", text: "done" });

function stubFilePanel(window: Window): string[] {
  const opened: string[] = [];
  (window as unknown as { __grokDeskFilePanel: { openPath: (p: string) => void } }).__grokDeskFilePanel = {
    openPath: (p) => { opened.push(p); },
  };
  return opened;
}

function lines(n: number, start = 1): string {
  return Array.from({ length: n }, (_, i) => `line ${i + start}`).join("\n");
}

describe("preview overlay — file reads (desktop)", () => {
  function seedRead(
    window: Window,
    file: string,
    excerpt: string,
    input: Record<string, unknown> = { offset: 1, limit: 12 },
  ) {
    dispatch(window, readCall("rd1", { target_file: file, ...input }));
    dispatch(window, readDone("rd1", excerpt, {
      type: "ReadFile",
      FileContent: { content: excerpt, offset: input.offset ?? 1, limit: input.limit ?? 12 },
    }));
    closeTurn(window);
  }

  it("shows the excerpt the agent read and never fetches the whole file", () => {
    const h = bootPreview();
    const excerpt = lines(12);
    seedRead(h.window, "src/a.ts", excerpt);
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    expect(h.posted.filter((m) => m.type === "readProjectFile")).toHaveLength(0);
    const overlay = h.doc.getElementById("preview-overlay")!;
    expect(overlay.querySelector(".preview-title")!.textContent).toBe("a.ts");
    expect(overlay.querySelector(".preview-notice")!.textContent).toMatch(/excerpt the agent read/);
    expect(overlay.querySelector(".preview-code")!.textContent).toBe(excerpt);
  });

  it("keeps the excerpt and hides Open in file panel for a path outside the workspace", () => {
    const h = bootPreview();
    stubFilePanel(h.window);
    const excerpt = lines(8);
    seedRead(h.window, "~/Downloads/x.md", excerpt, { offset: 1, limit: 8 });
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    expect(h.posted.filter((m) => m.type === "readProjectFile")).toHaveLength(0);
    const overlay = h.doc.getElementById("preview-overlay")!;
    expect(overlay.querySelector(".preview-notice")!.textContent).toMatch(/outside the project/);
    expect(overlay.querySelector(".preview-code")!.textContent).toBe(excerpt);
    expect(overlay.querySelector(".preview-open-panel")).toBeNull();
    expect(overlay.querySelector(".tdl")).toBeNull();
  });

  it("Open in file panel calls openPath with the file's relPath and closes the overlay", () => {
    const h = bootPreview();
    const opened = stubFilePanel(h.window);
    seedRead(h.window, "src/a.ts", lines(12));
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    const overlay = h.doc.getElementById("preview-overlay")!;
    const panelBtn = overlay.querySelector(".preview-open-panel") as HTMLButtonElement;
    expect(panelBtn.textContent).toBe("Open in file panel");
    click(h.window, panelBtn);
    expect(h.doc.getElementById("preview-overlay")).toBeNull();
    expect(opened).toEqual(["src/a.ts"]);
  });

  it("does not show Open in file panel when the host has no file panel", () => {
    const h = bootPreview();
    seedRead(h.window, "src/a.ts", lines(12));
    click(h.window, h.doc.querySelector(".tool-label-ref") as HTMLElement);
    expect(h.doc.querySelector(".preview-open-panel")).toBeNull();
  });
});
