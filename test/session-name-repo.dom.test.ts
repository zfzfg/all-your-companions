/**
 * The project label beside the conversation name in the VS Code chat header.
 *
 * VS Code history was pinned to the open folder, so the conversation name always
 * implied "in this workspace". The rail made history multi-workspace — a
 * conversation from any discovered project can be resumed without reloading the
 * window — and at that point the header stopped saying where you are.
 *
 * Two rules this file exists to hold: the label follows the CONVERSATION's cwd
 * (not the host's), and it stays out of the way when there is nothing to
 * disambiguate or when the name is being edited.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { bootWebview, dispatch, type Harness } from "./webview-harness";

const REPOS = [
  { cwd: "/work/app", label: "app", available: true, pinned: false, updatedAt: 2 },
  { cwd: "/work/relay", label: "relay", available: true, pinned: false, updatedAt: 1 },
];

/** `workspaceCwd` is the folder the EDITOR has open — the label's whole test. */
function sendRepos(h: Harness, entries = REPOS, workspaceCwd = "/work/app") {
  dispatch(h.window, {
    type: "repos",
    entries,
    selectedCwd: "/work/app",
    activeCwd: "/work/app",
    workspaceCwd,
  } as never);
}

function nameSession(h: Harness, cwd: string, name = "Some conversation") {
  dispatch(h.window, { type: "sessionName", sessionId: "s1", name, cwd } as never);
}

const tag = (h: Harness) => h.doc.getElementById("session-name-repo") as HTMLElement;

describe("session name project label", () => {
  // Owner decision 2026-08-15: the header shows JUST the conversation name,
  // everywhere — the rail groups by project and the tooltip keeps the path,
  // so the second line repeated what the surroundings already say. These pins
  // flipped from "shows when elsewhere" to "never shows".
  it("never renders, even for a conversation from another project", () => {
    const h = bootWebview();
    sendRepos(h);
    nameSession(h, "/work/relay");
    expect(tag(h).hidden).toBe(true);
  });

  it("stays hidden when same-named leaves would need the catalog label", () => {
    const h = bootWebview();
    sendRepos(h, [
      { cwd: "/a/site", label: "acme/site", available: true, pinned: false, updatedAt: 2 },
      { cwd: "/b/site", label: "beta/site", available: true, pinned: false, updatedAt: 1 },
    ]);
    nameSession(h, "/b/site");
    expect(tag(h).hidden).toBe(true);
  });

  it("stays quiet when the conversation is in the folder VS Code has open", () => {
    const h = bootWebview();
    sendRepos(h, REPOS, "/work/app");
    nameSession(h, "/work/app");
    expect(tag(h).hidden).toBe(true);
  });

  it("stays hidden after the catalog lands", () => {
    const h = bootWebview();
    nameSession(h, "/work/relay");
    sendRepos(h, REPOS, "/work/app");
    expect(tag(h).hidden).toBe(true);
  });

  it("stays hidden while the name is being edited", () => {
    const h = bootWebview();
    sendRepos(h, REPOS, "/work/app");
    nameSession(h, "/work/relay");
    expect(tag(h).hidden).toBe(true);

    const label = h.doc.getElementById("session-name-label")!;
    label.dispatchEvent(new (h.window as never as { MouseEvent: typeof MouseEvent }).MouseEvent(
      "click",
      { bubbles: true, cancelable: true },
    ));
    expect(h.doc.querySelector(".session-name-input")).toBeTruthy();
    expect(tag(h).hidden).toBe(true);
  });

  it("puts the rename pencil beside the NAME, not under the project line", () => {
    // Grid auto-placement, and the reason the pencil ended up on a third row:
    // the project line spans both columns, so it takes row 2 and moves the
    // placement cursor past row 1 — anything placing itself after it lands on
    // row 3. Both cells have to be placed explicitly.
    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    const chip = css.slice(css.indexOf(".session-name-chip {"));
    const repoRule = chip.slice(chip.indexOf(".session-name-chip > .session-name-repo"));
    expect(repoRule.slice(0, repoRule.indexOf("}"))).toMatch(/grid-row:\s*2/);
    const editRule = chip.slice(chip.indexOf(".session-name-chip > .session-name-edit"));
    expect(editRule.indexOf("{")).toBeGreaterThan(-1);
    const editBody = editRule.slice(0, editRule.indexOf("}"));
    expect(editBody).toMatch(/grid-column:\s*2/);
    expect(editBody).toMatch(/grid-row:\s*1/);
  });

  it("keeps the rename pencil's BOX while editing, so the top bar cannot resize", () => {
    // Measured against the real stylesheet before this was fixed: clicking the
    // name took the top bar from 46px to 39px and pulled the project line and
    // the separator up 7px with it. The pencil is a fixed 28px .icon-btn and
    // the tallest thing in the chip's first row, so removing it — not the
    // input's 2px — is what collapsed the row.
    //
    // jsdom has no layout, so this pins the mechanism rather than the pixels:
    // the button must stay in the flow (`hidden` takes it out) and be hidden by
    // visibility instead.
    const h = bootWebview();
    sendRepos(h);
    nameSession(h, "/work/relay");
    const pencil = h.doc.getElementById("session-name-edit")!;
    expect(pencil.hidden).toBe(false);

    h.doc.getElementById("session-name-label")!.dispatchEvent(
      new (h.window as never as { MouseEvent: typeof MouseEvent }).MouseEvent(
        "click",
        { bubbles: true, cancelable: true },
      ),
    );
    expect(h.doc.querySelector(".session-name-input")).toBeTruthy();
    expect(pencil.hidden, "removing it collapses the row").toBe(false);
    expect(pencil.classList.contains("session-name-edit-editing")).toBe(true);

    const css = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "chat.css"),
      "utf8",
    );
    const rule = css.slice(css.indexOf(".session-name-edit-editing"));
    // visibility, not opacity: opacity alone leaves it focusable and in the
    // a11y tree while the field beside it has the caret.
    expect(rule.slice(0, rule.indexOf("}"))).toMatch(/visibility:\s*hidden/);

    // ...and it comes back when the edit ends.
    const input = h.doc.querySelector(".session-name-input") as HTMLInputElement;
    input.dispatchEvent(new (h.window as never as { Event: typeof Event }).Event("blur"));
    expect(pencil.classList.contains("session-name-edit-editing")).toBe(false);
  });
});
