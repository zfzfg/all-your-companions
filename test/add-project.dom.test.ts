/**
 * Add project, in the real webview.
 *
 * Three ways in, three surfaces. What only a DOM run can show is the wiring:
 * that the menu carries what THIS host offers, that the form posts a name or a
 * URL and never a path, that a failure keeps the form open with something the
 * user can act on, and that a host too old to know any of this still gets the
 * folder picker it always had.
 *
 * The VS Code projects rail is a second renderer of the same shared menu and
 * form (media/webview-helpers.js); test/vscode-projects-rail.dom.test.ts covers
 * that one.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { bootWebview, click, dispatch, type Harness } from "./webview-harness";

const CAPS = {
  uploadFile: true,
  addProjectFolder: true,
  createProject: true,
  cloneProject: true,
};

function boot(opts: { caps?: Record<string, unknown>; coding?: boolean } = {}) {
  const h = bootWebview();
  dispatch(h.window, {
    type: "initialState",
    effort: "", cwd: "/w", useCtrlEnter: false, extVersion: "3.17.2",
    showThinking: false, expandCommandOutputs: false, steerByDefault: false,
    soundNotifications: false, processingSound: false, readRepliesAloud: false,
    appPurpose: opts.coding ? "coding" : "knowledge",
    capabilities: opts.caps ?? CAPS,
  });
  dispatch(h.window, { type: "projectSetup", root: "~/Grok Build" });
  h.posted.length = 0;
  return h;
}

/** The rail's + button is only mounted on a rail-bearing surface, so drive the
 *  same entry point the no-project empty state uses. */
function openMenu(h: Harness) {
  h.window.eval(`document.body.__openAddProject()`);
}

const menuItems = (h: Harness) =>
  [...h.doc.querySelectorAll(".rail-menu-item")].map(
    (el) => (el.querySelector(".rail-menu-label") || el).textContent?.trim() || "",
  );
const form = (h: Harness) => h.doc.querySelector(".add-project-form") as HTMLElement | null;
const input = (h: Harness) => h.doc.querySelector(".add-project-input") as HTMLInputElement;
const dest = (h: Harness) => (h.doc.querySelector(".add-project-dest")?.textContent || "").trim();
const problem = (h: Harness) => h.doc.querySelector(".add-project-error") as HTMLElement | null;
const fix = (h: Harness) => h.doc.querySelector(".add-project-fix") as HTMLButtonElement | null;
const submit = (h: Harness) =>
  h.doc.querySelector(".add-project-primary") as HTMLButtonElement;

/** Expose the menu opener the rail button would call. chat.js keeps it inside
 *  its IIFE, so reach it the way the onboarding card does. */
function installOpener(h: Harness) {
  h.window.eval(`
    document.body.__openAddProject = () => {
      const card = document.getElementById("welcome-onboarding");
      card.innerHTML = '<button class="onb-action" type="button" data-act="addProjectFolder">Add project folder</button>';
      card.querySelector("button").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    };
  `);
}

describe("add project", () => {
  it("offers cloning in Knowledge work, at the top, the same as in Coding", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    expect(menuItems(h)).toEqual(["Clone from GitHub", "New project", "Import a folder"]);
  });

  it("adds cloning in Coding, at the top, and takes nothing away", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    expect(menuItems(h)).toEqual(["Clone from GitHub", "New project", "Import a folder"]);
  });

  it("explains each entry, because they differ by a verb", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    const descriptions = [...h.doc.querySelectorAll(".rail-menu-desc")].map((el) => el.textContent);
    expect(descriptions).toEqual([
      "Pick a repository, or type a URL.",
      "Name it. We make the folder.",
      "Choose one you already have.",
    ]);
  });

  it("stays a plain picker on a host that offers nothing else", () => {
    // An older host advertises `addProjectFolder` alone. One way in is a click,
    // not a menu that asks permission to be a click.
    const h = boot({ caps: { uploadFile: true, addProjectFolder: true } });
    installOpener(h);
    openMenu(h);
    expect(h.doc.querySelector(".rail-menu")).toBeNull();
    expect(h.posted).toContainEqual({ type: "addProjectFolder" });
  });

  it("still opens the picker when capabilities have not arrived yet", () => {
    // The no-project card can be on screen before `initialState` lands, and its
    // button has to do something.
    const h = bootWebview();
    installOpener(h);
    openMenu(h);
    expect(h.posted).toContainEqual({ type: "addProjectFolder" });
  });

  it("shows the destination as you type, and posts a NAME", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    const newItem = [...h.doc.querySelectorAll(".rail-menu-item")].find((el) =>
      el.textContent?.includes("New project"),
    )!;
    click(h.window, newItem);
    expect(form(h)).toBeTruthy();
    expect(dest(h)).toBe("~/Grok Build/…");
    input(h).value = "Q3 Positioning";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(dest(h)).toBe("~/Grok Build/Q3 Positioning");
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({ type: "createProject", name: "Q3 Positioning" });
    // A name, never a path: the host decides where the folder goes.
    expect(JSON.stringify(h.posted)).not.toContain("/Grok Build/");
  });

  it("previews the folder a clone URL implies, and posts the URL", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    input(h).value = "https://github.com/phuryn/grok-remote.git";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(dest(h)).toBe("~/Grok Build/grok-remote");
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({
      type: "cloneProject",
      url: "https://github.com/phuryn/grok-remote.git",
    });
  });

  it("refuses to submit an empty field", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    expect(submit(h).disabled).toBe(true);
    click(h.window, submit(h));
    expect(h.posted.some((m) => m.type === "createProject")).toBe(false);
  });

  it("says what it is doing while the host works", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", busy: "clone" });
    // Label plus the shared .blink-dots, not a static "…": a frozen ellipsis
    // read as a stuck button (owner, 2026-09-01). textContent flattens the
    // three dot spans, so assert the parts rather than a single string.
    expect(submit(h).textContent).toContain("Cloning");
    expect(submit(h).querySelector(".blink-dots")).toBeTruthy();
    expect(submit(h).querySelectorAll(".blink-dots span")).toHaveLength(3);
    expect(submit(h).disabled).toBe(true);
    expect(input(h).disabled).toBe(true);
  });

  it("keeps the form open on failure, with the error to read", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup", root: "~/Grok Build", error: '"Q3" is already in ~/Grok Build.',
    });
    expect(form(h)).toBeTruthy();
    expect(problem(h)?.hidden).toBe(false);
    expect(problem(h)?.textContent).toContain("already in");
    // No fix offered for a failure nothing can fix for them.
    expect(fix(h)?.hidden).toBe(true);
  });

  it("offers to sign in to GitHub when that is what would fix it", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "auth-gh",
    });
    expect(fix(h)?.hidden).toBe(false);
    expect(fix(h)?.textContent).toBe("Sign in to GitHub");
    click(h.window, fix(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
    // The form stays up: signing in happens in a terminal, and the user comes
    // back here to try again.
    expect(form(h)).toBeTruthy();
  });

  const githubBox = (h: Harness) => h.doc.querySelector(".add-project-github") as HTMLElement | null;
  const githubConnect = (h: Harness) =>
    h.doc.querySelector(".add-project-github-connect") as HTMLButtonElement | null;

  it("step 1 is a choice, with no code, until they press connect", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    const box = githubBox(h);
    expect(box?.hidden).toBe(false);
    expect(box?.dataset.phase).toBe("choice");
    expect(githubConnect(h)?.textContent).toBe("Connect with GitHub CLI");
    expect(h.doc.querySelector(".add-project-github-advanced")?.textContent)
      .toBe("Use a token instead");
    expect(h.doc.querySelector<HTMLElement>(".add-project-github-token")?.hidden).toBe(true);
    expect(h.doc.querySelector<HTMLElement>(".add-project-github-card")?.hidden).toBe(true);
  });

  it("pressing connect replaces the choice with the sign-in card", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    h.posted.length = 0;
    click(h.window, githubConnect(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
    expect(githubBox(h)?.dataset.phase).toBe("cli");
    expect(githubConnect(h)?.closest<HTMLElement>(".add-project-github-choice")?.hidden).toBe(true);
    expect(h.doc.querySelector<HTMLElement>(".add-project-github-card")?.hidden).toBe(false);
    expect(input(h).hidden).toBe(true);
  });

  it("reopening the form returns to step 1", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    click(h.window, githubConnect(h)!);
    expect(githubBox(h)?.dataset.phase).toBe("cli");
    click(h.window, h.doc.querySelector(".add-project-btn:not(.add-project-primary)") as HTMLElement);
    expect(form(h)).toBeNull();
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    expect(form(h)).toBeTruthy();
    expect(githubBox(h)?.dataset.phase).toBe("choice");
    expect(githubConnect(h)).toBeTruthy();
  });

  it("ignores github on an older frame that does not carry it", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "auth-gh",
    });
    expect(githubBox(h)?.dataset.phase).toBe("choice");
    expect(h.doc.querySelector<HTMLElement>(".add-project-github-card")?.hidden).toBe(true);
    expect(fix(h)?.hidden).toBe(false);
  });

  it("names the install command when the CLI is missing", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "projectSetup",
      root: "~/Grok Build",
      error: "Git couldn't authenticate.",
      fix: "install-gh",
      fixCommand: "winget install --id GitHub.cli -e",
    });
    // Nobody should be asked to approve a command they cannot read.
    expect(fix(h)?.textContent).toContain("winget install --id GitHub.cli -e");
    click(h.window, fix(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "install" });
  });

  it("clears a stale fix when the next failure does not earn one", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", error: "auth", fix: "auth-gh" });
    expect(fix(h)?.hidden).toBe(false);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", error: "Could not resolve host." });
    expect(fix(h)?.hidden).toBe(true);
  });

  it("closes only on done — not on a failure that also stopped being busy", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", error: "nope" });
    expect(form(h)).toBeTruthy();
    dispatch(h.window, { type: "projectSetup", root: "~/Grok Build", done: true });
    expect(form(h)).toBeNull();
  });

  it("closes on Escape and on Cancel", () => {
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    const cancel = h.doc.querySelector(".add-project-btn:not(.add-project-primary)") as HTMLElement;
    click(h.window, cancel);
    expect(form(h)).toBeNull();

    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    expect(form(h)).toBeTruthy();
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(form(h)).toBeNull();
  });

  it("stops listening for Escape once the form is gone", () => {
    // Capture-phase listener: leaving it attached would swallow Escape
    // everywhere else in the app for the rest of the session.
    const h = boot();
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    let reached = false;
    h.doc.addEventListener("keydown", () => { reached = true; });
    h.doc.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(reached).toBe(true);
  });

  const optionLabels = (h: Harness) =>
    [...h.doc.querySelectorAll(".add-project-option")].map((el) => el.textContent || "");

  it("filters the fetched list locally and offers a typed URL as a row", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: true, login: "phuryn", cliPresent: true },
    });
    dispatch(h.window, {
      type: "githubRepos",
      repos: [
        { nameWithOwner: "phuryn/afkpilot", isPrivate: false, updatedAt: "2026-09-03T21:55:15Z" },
        { nameWithOwner: "phuryn/secret", isPrivate: true, updatedAt: "2026-09-01T00:00:00Z" },
      ],
    });
    expect(optionLabels(h).join("\n")).toMatch(/afkpilot/);
    expect(optionLabels(h).join("\n")).toMatch(/secret/);
    input(h).value = "afk";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(optionLabels(h).join("\n")).toMatch(/afkpilot/);
    expect(optionLabels(h).join("\n")).not.toMatch(/secret/);
    input(h).value = "https://github.com/you/other";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(optionLabels(h).some((t) => t.includes("Clone https://github.com/you/other"))).toBe(true);
    h.posted.length = 0;
    click(h.window, h.doc.querySelector(".add-project-option")!);
    expect(h.posted.some((m) => m.type === "cloneProject")).toBe(false);
    expect(input(h).value).toBe("https://github.com/you/other");
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({ type: "cloneProject", url: "https://github.com/you/other" });
  });

  it("keeps the public URL path open when GitHub is not connected", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    expect(githubConnect(h)).toBeTruthy();
    input(h).value = "https://github.com/phuryn/afkpilot";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(optionLabels(h).some((t) => t.includes("Clone https://github.com/phuryn/afkpilot"))).toBe(true);
    expect(submit(h).disabled).toBe(false);
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({
      type: "cloneProject",
      url: "https://github.com/phuryn/afkpilot",
    });
  });

  it("runs Connect from the step-1 CLI button", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    h.posted.length = 0;
    click(h.window, githubConnect(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
  });

  it("the token path is a second step, not a field that is simply present", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    expect(h.doc.querySelector<HTMLElement>(".add-project-github-token")?.hidden).toBe(true);
    click(h.window, h.doc.querySelector(".add-project-github-advanced") as HTMLElement);
    expect(githubBox(h)?.dataset.phase).toBe("token");
    expect(h.doc.querySelector<HTMLElement>(".add-project-github-token")?.hidden).toBe(false);
    expect(h.doc.querySelector(".add-project-github-token-input")).toBeTruthy();
    expect(githubConnect(h)?.closest<HTMLElement>(".add-project-github-choice")?.hidden).toBe(true);
  });

  it("picking a repository fills the field and does not clone until the button is pressed", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: true, login: "phuryn", cliPresent: true },
    });
    dispatch(h.window, {
      type: "githubRepos",
      repos: [
        { nameWithOwner: "phuryn/afkpilot", isPrivate: false, updatedAt: "2026-09-03T21:55:15Z" },
        { nameWithOwner: "phuryn/secret", isPrivate: true, updatedAt: "2026-09-01T00:00:00Z" },
      ],
    });
    h.posted.length = 0;
    const row = [...h.doc.querySelectorAll(".add-project-option")].find((el) =>
      (el.textContent || "").includes("afkpilot"),
    )!;
    click(h.window, row);
    expect(h.posted).toEqual([]);
    expect(input(h).value).toBe("phuryn/afkpilot");
    expect(dest(h)).toContain("afkpilot");
    click(h.window, submit(h));
    expect(h.posted).toContainEqual({
      type: "cloneProject",
      url: "https://github.com/phuryn/afkpilot",
    });
  });

  it("Enter on a highlighted row selects it and does not clone", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: true, login: "phuryn", cliPresent: true },
    });
    dispatch(h.window, {
      type: "githubRepos",
      repos: [
        { nameWithOwner: "phuryn/afkpilot", isPrivate: false, updatedAt: "2026-09-03T21:55:15Z" },
      ],
    });
    h.posted.length = 0;
    input(h).dispatchEvent(new h.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(h.posted.some((m) => m.type === "cloneProject")).toBe(false);
    expect(input(h).value).toBe("phuryn/afkpilot");
  });

  it("keeps the repository list mounted while filtering so the dialog cannot jump", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: true, login: "phuryn", cliPresent: true },
    });
    dispatch(h.window, {
      type: "githubRepos",
      repos: [
        { nameWithOwner: "phuryn/afkpilot", isPrivate: false, updatedAt: "2026-09-03T21:55:15Z" },
        { nameWithOwner: "phuryn/secret", isPrivate: true, updatedAt: "2026-09-01T00:00:00Z" },
        { nameWithOwner: "phuryn/one", isPrivate: false, updatedAt: "2026-08-01T00:00:00Z" },
        { nameWithOwner: "phuryn/two", isPrivate: false, updatedAt: "2026-08-02T00:00:00Z" },
        { nameWithOwner: "phuryn/three", isPrivate: false, updatedAt: "2026-08-03T00:00:00Z" },
      ],
    });
    const list = h.doc.querySelector(".add-project-list") as HTMLElement;
    expect(list.hidden).toBe(false);
    input(h).value = "zzz-no-match";
    input(h).dispatchEvent(new h.window.Event("input", { bubbles: true }));
    expect(list.hidden).toBe(false);
    expect(list.querySelectorAll(".add-project-option").length).toBe(0);
    const css = [
      readFileSync(fileURLToPath(new URL("../media/chat.css", import.meta.url)), "utf8"),
      readFileSync(fileURLToPath(new URL("../media/projects-rail.css", import.meta.url)), "utf8"),
    ].join("\n");
    expect(css).toMatch(/\.add-project-list\s*\{[^}]*height:\s*13\.75rem/);
    expect(css).toMatch(/\.add-project-scrim\s*\{[^}]*align-items:\s*flex-start/);
  });

  it("offers Re-check connection after a desk GitHub CLI sign-in from the clone form", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    h.posted.length = 0;
    click(h.window, githubConnect(h)!);
    expect(h.posted).toContainEqual({ type: "setupGithubCli", action: "auth" });
    const recheck = h.doc.querySelector(".add-project-github-recheck") as HTMLButtonElement;
    expect(recheck.hidden).toBe(false);
    expect(recheck.textContent).toBe("Re-check connection");
    h.posted.length = 0;
    click(h.window, recheck);
    expect(h.posted).toContainEqual({ type: "refreshProviders" });
  });

  it("makes 'fine-grained token' a new-tab link in the token step", () => {
    const h = boot({ coding: true });
    installOpener(h);
    openMenu(h);
    click(h.window, [...h.doc.querySelectorAll(".rail-menu-item")][0]);
    dispatch(h.window, {
      type: "githubState",
      github: { connected: false, cliPresent: true },
    });
    click(h.window, h.doc.querySelector(".add-project-github-advanced") as HTMLElement);
    const link = h.doc.querySelector(".add-project-github-token-link") as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.textContent).toBe("fine-grained token");
    expect(link.getAttribute("href")).toBe("https://github.com/settings/personal-access-tokens/new");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
  });
});
