// AP-03 — the composer half, driven through the REAL media/chat.js in happy-dom:
// `@prob` offers the diagnostics entry, picking it rewrites the token and asks
// the host for a chip, the chip renders as its own attachment row, and
// removeChip takes it away again. Plus the `+` popover's two matching items.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click, type Harness } from "./webview-harness";
import { MENTION_SOURCES } from "../src/mention";
import { makeDiagnosticsChip, makeTerminalChip } from "../src/context-chips";

type TextArea = HTMLTextAreaElement;

function typeInComposer(h: Harness, text: string): TextArea {
  const input = h.doc.getElementById("input") as TextArea;
  input.value = text;
  // happy-dom doesn't move the caret on programmatic value writes — pin it to
  // the end the way a real keystroke leaves it.
  input.selectionStart = text.length;
  input.selectionEnd = text.length;
  input.dispatchEvent(new (h.window as any).Event("input", { bubbles: true }));
  return input;
}

function key(h: Harness, k: string): void {
  const input = h.doc.getElementById("input") as TextArea;
  input.dispatchEvent(
    new (h.window as any).KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }),
  );
}

const popover = (h: Harness) => h.doc.getElementById("mention-popover") as HTMLElement;
const rows = (h: Harness) => [...popover(h).querySelectorAll(".mention-item")] as HTMLElement[];
const attachments = (h: Harness) =>
  [...(h.doc.getElementById("attachments") as HTMLElement).querySelectorAll(".attachment")] as HTMLElement[];

/** The `sources` array the host answers a mentionQuery with. */
const sources = (...ids: string[]) =>
  MENTION_SOURCES.filter((entry) => ids.includes(entry.source));

describe("@ autocomplete offers the host-collected sources", () => {
  it("`@prob` shows the diagnostics entry ahead of the files", () => {
    const h = bootWebview();
    typeInComposer(h, "@prob");
    dispatch(h.window, {
      type: "mentionResults",
      query: "prob",
      files: ["src/problem-parser.ts"],
      sources: sources("problems"),
    });

    expect(popover(h).hidden).toBe(false);
    const items = rows(h);
    expect(items.length).toBe(2);
    expect(items[0].classList.contains("mention-source")).toBe(true);
    expect(items[0].querySelector(".mention-name")?.textContent).toBe("@problems");
    expect(items[0].querySelector(".mention-dir")?.textContent)
      .toBe("Errors and warnings the editor is reporting");
    // Head of the list means head of the list: it is also what Enter picks.
    expect(items[0].classList.contains("active")).toBe(true);
    // Ranking of the FILES is untouched — they still follow, in host order.
    expect(items[1].classList.contains("mention-source")).toBe(false);
    expect(items[1].querySelector(".mention-name")?.textContent).toBe("problem-parser.ts");
  });

  it("shows both entries on a bare `@`", () => {
    const h = bootWebview();
    typeInComposer(h, "@");
    dispatch(h.window, {
      type: "mentionResults",
      query: "",
      files: [],
      sources: sources("problems", "terminal"),
    });
    expect(rows(h).map((r) => r.querySelector(".mention-name")?.textContent))
      .toEqual(["@problems", "@terminal"]);
  });

  it("opens the popover for sources even when NO file matched", () => {
    // Without this, `@terminal` in a workspace with no matching filename would
    // hide the popover and the entry could never be picked.
    const h = bootWebview();
    typeInComposer(h, "@terminal");
    dispatch(h.window, {
      type: "mentionResults",
      query: "terminal",
      files: [],
      sources: sources("terminal"),
    });
    expect(popover(h).hidden).toBe(false);
    expect(rows(h).length).toBe(1);
  });

  it("clicking the entry rewrites the token and asks the host for a chip", () => {
    const h = bootWebview();
    const input = typeInComposer(h, "fix @prob");
    dispatch(h.window, {
      type: "mentionResults", query: "prob", files: [], sources: sources("problems"),
    });

    click(h.window, rows(h)[0]);

    expect(input.value).toBe("fix @problems ");
    expect(h.posted.filter((p) => p.type === "addContextChip")).toEqual([
      { type: "addContextChip", source: "problems" },
    ]);
    // It is NOT a file: the file pipeline must not be asked to resolve it.
    expect(h.posted.filter((p) => p.type === "addMentionFile")).toEqual([]);
    expect(popover(h).hidden).toBe(true);
  });

  it("the keyboard walks sources and files as one list", () => {
    const h = bootWebview();
    const input = typeInComposer(h, "@t");
    dispatch(h.window, {
      type: "mentionResults",
      query: "t",
      files: ["src/tools.ts"],
      sources: sources("terminal"),
    });

    key(h, "ArrowDown"); // off the source, onto the file
    key(h, "Enter");
    expect(input.value).toBe("@src/tools.ts ");
    expect(h.posted.filter((p) => p.type === "addMentionFile")).toEqual([
      { type: "addMentionFile", relPath: "src/tools.ts" },
    ]);
    expect(h.posted.filter((p) => p.type === "addContextChip")).toEqual([]);
  });

  it("ArrowUp from the first row wraps to the last FILE, not off the end", () => {
    const h = bootWebview();
    const input = typeInComposer(h, "@t");
    dispatch(h.window, {
      type: "mentionResults",
      query: "t",
      files: ["a.ts", "b.ts"],
      sources: sources("terminal"),
    });
    key(h, "ArrowUp");
    key(h, "Enter");
    expect(input.value).toBe("@b.ts ");
  });

  it("Enter on the source row picks the source", () => {
    const h = bootWebview();
    typeInComposer(h, "@term");
    dispatch(h.window, {
      type: "mentionResults", query: "term", files: ["x.ts"], sources: sources("terminal"),
    });
    key(h, "Enter");
    expect(h.posted.filter((p) => p.type === "addContextChip")).toEqual([
      { type: "addContextChip", source: "terminal" },
    ]);
  });

  it("a host that sends no `sources` behaves exactly as before", () => {
    // The additive-field contract, from the client's side.
    const h = bootWebview();
    const input = typeInComposer(h, "@ch");
    dispatch(h.window, { type: "mentionResults", query: "ch", files: ["src/chips.ts"] });
    expect(rows(h).length).toBe(1);
    key(h, "Enter");
    expect(input.value).toBe("@src/chips.ts ");
  });

  it("closing the popover forgets the sources too", () => {
    const h = bootWebview();
    typeInComposer(h, "@prob");
    dispatch(h.window, {
      type: "mentionResults", query: "prob", files: [], sources: sources("problems"),
    });
    key(h, "Escape");
    expect(popover(h).hidden).toBe(true);
    // A stale source list would otherwise let Enter pick a row nobody can see.
    key(h, "Enter");
    expect(h.posted.filter((p) => p.type === "addContextChip")).toEqual([]);
  });
});

describe("the chips themselves", () => {
  it("renders a diagnostics chip as its own removable attachment row", () => {
    const h = bootWebview();
    const chip = makeDiagnosticsChip({ scope: "workspace", count: 12 });
    dispatch(h.window, { type: "chips", chips: [chip] });

    const row = attachments(h)[0];
    expect(row.querySelector("span")?.textContent).toBe("12 problems");
    expect(row.title).toContain("the whole workspace");
    expect(row.title).toContain("collected again when you send");
    // No eye toggle: it is an explicit attachment, like an attached file.
    expect(h.doc.getElementById("chips")?.children.length).toBe(0);
  });

  it("renders a terminal chip with its name and captured size", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "chips",
      chips: [makeTerminalChip({ label: "npm run dev", bytes: 4300 })],
    });
    const row = attachments(h)[0];
    expect(row.querySelector("span")?.textContent).toBe("Terminal: npm run dev");
    expect(row.title).toContain("4.2 KB");
  });

  it("clicking the row asks the host to reveal the source it stands for", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "chips",
      chips: [makeDiagnosticsChip({ scope: "workspace", count: 2 })],
    });
    click(h.window, attachments(h)[0]);
    expect(h.posted.filter((p) => p.type === "openContextChipSource")).toEqual([
      { type: "openContextChipSource", source: "problems" },
    ]);
  });

  it("the × removes it — and does not also open the panel", () => {
    const h = bootWebview();
    const chip = makeDiagnosticsChip({ scope: "workspace", count: 2 });
    dispatch(h.window, { type: "chips", chips: [chip] });

    click(h.window, attachments(h)[0].querySelector(".attachment-remove") as HTMLElement);
    expect(h.posted.filter((p) => p.type === "removeChip")).toEqual([
      { type: "removeChip", id: chip.id },
    ]);
    expect(h.posted.filter((p) => p.type === "openContextChipSource")).toEqual([]);

    // The host answers with the new list; the row goes.
    dispatch(h.window, { type: "chips", chips: [] });
    expect(attachments(h).length).toBe(0);
  });

  it("renders alongside file chips without disturbing them", () => {
    const h = bootWebview();
    dispatch(h.window, {
      type: "chips",
      chips: [
        { id: "explicit:/repo/src/a.ts:0-0:1", path: "/repo/src/a.ts", relPath: "src/a.ts", hidden: false },
        makeTerminalChip({ label: "bash", bytes: 40 }),
      ],
    });
    expect(attachments(h).map((el) => el.querySelector("span")?.textContent))
      .toEqual(["a.ts", "Terminal: bash"]);
  });

  it("an UNKNOWN future kind still renders, from relPath, instead of throwing", () => {
    // A Git-diff chip from a newer host reaching this client. It must degrade
    // to a plain chip — a TypeError here takes the whole composer with it.
    const h = bootWebview();
    dispatch(h.window, {
      type: "chips",
      chips: [{ kind: "gitDiff", id: "git:1", relPath: "Git diff (3 files)", path: "", hidden: false }],
    });
    expect(attachments(h)[0].querySelector("span")?.textContent).toBe("Git diff (3 files)");
  });
});

describe("the + popover offers the same two sources", () => {
  it("lists upload, problems and terminal", () => {
    const h = bootWebview();
    click(h.window, h.doc.getElementById("add-btn") as HTMLElement);
    const items = [...(h.doc.getElementById("add-popover") as HTMLElement)
      .querySelectorAll(".toolbar-popover-item")] as HTMLElement[];
    expect(items.map((el) => el.textContent?.trim())).toEqual([
      "Upload from computer",
      "Problems (errors & warnings)",
      "Terminal output",
    ]);
  });

  it("posts the same addContextChip the @ pick does", () => {
    const h = bootWebview();
    click(h.window, h.doc.getElementById("add-btn") as HTMLElement);
    const items = [...(h.doc.getElementById("add-popover") as HTMLElement)
      .querySelectorAll(".toolbar-popover-item")] as HTMLElement[];
    click(h.window, items[2]);
    expect(h.posted.filter((p) => p.type === "addContextChip")).toEqual([
      { type: "addContextChip", source: "terminal" },
    ]);
    expect((h.doc.getElementById("add-popover") as HTMLElement).hidden).toBe(true);
  });
});
