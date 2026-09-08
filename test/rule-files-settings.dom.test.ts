/**
 * AP-04's Settings → Advanced "Rule files" row — the webview half of the
 * rule/instruction-file panel (the host half is test/rules-files.test.ts).
 *
 * Mutation-checked requirements:
 *   1. Opening Advanced asks the host for the list exactly once
 *   2. A loading list ("not yet answered") reads differently from an
 *      answered-but-empty one, matching the routines/mcpServers null-vs-[]
 *      convention
 *   3. An existing file shows its provider badges, size, and an "Open" button
 *      that posts openRuleFile with the EXACT path the host sent — never a
 *      path the webview invents
 *   4. A missing candidate renders greyed (is-missing) with a "Create" button
 *      posting the same message shape
 *   5. An empty provider list renders "may be read", never a guessed provider
 *   6. The whole row (list, buttons) is absent in remote mode — host-local,
 *      same as openGlobalConfig/openProjectConfig
 */
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const settingsSrc = readFileSync(
  fileURLToPath(new URL("../media/settings.js", import.meta.url)),
  "utf8",
);

function boot(opts: {
  ruleFiles?: unknown;
  isRemote?: boolean;
  category?: string;
} = {}) {
  const window = new Window({ url: "https://localhost/" });
  (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
  const api = (window as unknown as { GrokSettings: Record<string, any> }).GrokSettings;
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const posted: Array<Record<string, unknown>> = [];
  const env = api.defaultEnv({ isRemote: !!opts.isRemote, isDesktop: true, providersKnown: true });
  const snapshot = api.defaultSnapshot({
    ruleFiles: opts.ruleFiles === undefined ? null : opts.ruleFiles,
  });
  const surface = api.mount(root, {
    snapshot,
    env,
    standalone: true,
    category: opts.category || "advanced",
    post: (msg: Record<string, unknown>) => posted.push(msg),
  });
  return { api, doc, root, posted, window, surface };
}

function click(el: Element | null): void {
  if (!el) throw new Error("nothing to click");
  (el as HTMLElement).click();
}

const AGENTS_MD = {
  path: "/proj/AGENTS.md",
  label: "AGENTS.md (project)",
  scope: "project",
  kind: "file",
  providers: ["codex", "grok"],
  exists: true,
  bytes: 42,
};

const GEMINI_MD_MISSING = {
  path: "/proj/GEMINI.md",
  label: "GEMINI.md (project)",
  scope: "project",
  kind: "file",
  providers: ["gemini"],
  exists: false,
};

const UNCERTAIN = {
  path: "/proj/.mystery",
  label: ".mystery/ (project)",
  scope: "project",
  kind: "directory",
  providers: [],
  exists: true,
};

describe("Rule files panel", () => {
  it("asks the host for the list exactly once on opening Advanced (req 1)", () => {
    const { posted } = boot({ ruleFiles: [AGENTS_MD] });
    expect(posted.filter((m) => m.type === "listRuleFiles")).toHaveLength(1);
  });

  it("does not ask again on an unrelated repaint", () => {
    const { posted, surface, window } = boot({ ruleFiles: [AGENTS_MD] });
    const env = (window as unknown as { GrokSettings: Record<string, any> }).GrokSettings.defaultEnv({
      isRemote: false, isDesktop: true, providersKnown: true,
    });
    surface.update((window as unknown as { GrokSettings: Record<string, any> }).GrokSettings.defaultSnapshot({
      ruleFiles: [AGENTS_MD],
    }), env);
    expect(posted.filter((m) => m.type === "listRuleFiles")).toHaveLength(1);
  });

  it("shows a loading state, not an empty-list message, while ruleFiles is null (req 2)", () => {
    const { root } = boot({ ruleFiles: null });
    const state = root.querySelector(".settings-mcp-state");
    expect(state).toBeTruthy();
    expect(state!.textContent).not.toMatch(/no /i);
  });

  it("shows the empty-list message once the host answers with nothing", () => {
    const { root } = boot({ ruleFiles: [] });
    const state = root.querySelector(".settings-mcp-state");
    expect(state).toBeTruthy();
    expect(state!.textContent).toMatch(/no project or home directory/i);
  });

  it("renders an existing file with provider badges, size, and posts openRuleFile with the exact path (req 3)", () => {
    const { root, posted } = boot({ ruleFiles: [AGENTS_MD] });
    const row = root.querySelector(".settings-rules-row");
    expect(row).toBeTruthy();
    expect(row!.className).not.toContain("is-missing");
    const badges = [...row!.querySelectorAll(".settings-rules-badge")].map((b) => b.textContent);
    expect(badges).toEqual(["Codex", "Grok"]);
    expect(row!.querySelector(".settings-row-desc")?.textContent).toContain("/proj/AGENTS.md");
    expect(row!.querySelector(".settings-row-desc")?.textContent).toMatch(/42 B/);
    const btn = row!.querySelector(".settings-rules-open") as HTMLButtonElement;
    expect(btn.textContent).toBe("Open");
    expect(btn.dataset.path).toBe("/proj/AGENTS.md");
    click(btn);
    expect(posted).toContainEqual({ type: "openRuleFile", path: "/proj/AGENTS.md" });
  });

  it("renders a missing candidate greyed out with a Create button (req 4)", () => {
    const { root, posted } = boot({ ruleFiles: [GEMINI_MD_MISSING] });
    const row = root.querySelector(".settings-rules-row")!;
    expect(row.className).toContain("is-missing");
    expect(row.querySelector(".settings-row-desc")?.textContent).toMatch(/not created yet/);
    const btn = row.querySelector(".settings-rules-open") as HTMLButtonElement;
    expect(btn.textContent).toBe("Create");
    click(btn);
    expect(posted).toContainEqual({ type: "openRuleFile", path: "/proj/GEMINI.md" });
  });

  it('shows "may be read" instead of a guessed provider for an empty provider list (req 5)', () => {
    const { root } = boot({ ruleFiles: [UNCERTAIN] });
    const badge = root.querySelector(".settings-rules-badge.is-uncertain");
    expect(badge).toBeTruthy();
    expect(badge!.textContent).toBe("may be read");
  });

  it("hides the whole panel in remote mode (host-local, req 6)", () => {
    const { root, posted } = boot({ ruleFiles: [AGENTS_MD], isRemote: true });
    expect(root.querySelector(".settings-rules-list")).toBeNull();
    expect(root.querySelector('[data-id="ruleFiles"]')).toBeNull();
    expect(posted.filter((m) => m.type === "listRuleFiles")).toHaveLength(0);
  });
});
