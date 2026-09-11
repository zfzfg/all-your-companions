/**
 * Settings → Agents & Crew → Routing rules (AP-16 §6.2, P6).
 *
 * The list is ordered and the order is precedence, so a move-up control is a
 * real edit rather than cosmetics. The page never decides anything: it posts
 * the whole list and repaints from whatever the host sends back.
 */
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const settingsSrc = readFileSync(fileURLToPath(new URL("../media/settings.js", import.meta.url)), "utf8");
const settingsCss = readFileSync(fileURLToPath(new URL("../media/settings.css", import.meta.url)), "utf8");

const providers = [
  { id: "gemini", label: "Google Antigravity", connected: true, models: [{ modelId: "m-fast", name: "Fast" }] },
  { id: "claude", label: "Claude Code", connected: true, models: [{ modelId: "m-strong" }] },
];

function mount(snapshotOver: Record<string, unknown> = {}) {
  const window = new Window({ url: "https://localhost/" });
  const document = window.document;
  (globalThis as Record<string, unknown>).window = window;
  (globalThis as Record<string, unknown>).document = document;
  const style = document.createElement("style");
  style.textContent = settingsCss;
  document.head.appendChild(style);
  const module = { exports: {} as Record<string, unknown> };
  new window.Function("module", "globalThis", settingsSrc)(module, window);
  const api = module.exports as {
    defaultSnapshot: (p?: Record<string, unknown>) => Record<string, unknown>;
    defaultEnv: (p?: Record<string, unknown>) => Record<string, unknown>;
    mount: (el: unknown, opts: Record<string, unknown>) => unknown;
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const posted: Record<string, unknown>[] = [];
  api.mount(root, {
    snapshot: api.defaultSnapshot({
      agentRoles: [],
      crewFlows: [],
      workflows: [],
      agentRoleProviders: providers,
      efforts: ["low", "medium", "high"],
      subagentRouting: [],
      subagentRoster: [],
      ...snapshotOver,
    }),
    env: api.defaultEnv({}),
    post: (msg: Record<string, unknown>) => posted.push(msg),
    standalone: true,
    category: "agents",
  });
  return { window, root, posted, document };
}

const q = (root: unknown, sel: string) => (root as { querySelector: (s: string) => unknown }).querySelector(sel) as never;
const qa = (root: unknown, sel: string) =>
  Array.from((root as { querySelectorAll: (s: string) => unknown[] }).querySelectorAll(sel)) as never[];

const rule = (over: Record<string, unknown> = {}) => ({
  match: ["inspect", "overview"],
  provider: "gemini",
  model: "",
  effort: "low",
  ...over,
});

const routingSaves = (posted: Record<string, unknown>[]) =>
  posted.filter((m) => m.type === "subagentRoutingSave");

describe("Routing rules settings", () => {
  it("says what a rule can and cannot do", () => {
    // A rule that silently does nothing is otherwise indistinguishable from a
    // bug, so the hint states both limits: it never beats an explicit choice,
    // and it never widens what is eligible.
    const { root } = mount();
    const panel = q(root, ".settings-routing") as { textContent: string };
    expect(panel.textContent).toContain("Rules are advice, not overrides");
    expect(panel.textContent).toContain("Earlier rules win");
  });

  it("paints an existing rule's keywords and target", () => {
    const { root } = mount({ subagentRouting: [rule()] });
    const keywords = q(root, ".settings-routing-keywords") as { value: string };
    expect(keywords.value).toBe("inspect, overview");
    const selects = qa(root, ".settings-routing-row select") as { value: string }[];
    expect(selects[0].value).toBe("gemini");
    expect(selects[2].value).toBe("low");
  });

  it("adds a draft rule, and saves it only once it has words and a companion", () => {
    // The host drops a rule with no keywords or no target (parseRoutingRules),
    // so posting the empty row made it vanish on the next frame: "Add rule"
    // looked like it did nothing.
    const { window, root, posted } = mount();
    (q(root, ".settings-routing-new") as { click: () => void }).click();
    expect(routingSaves(posted)).toHaveLength(0);
    const draft = q(document, '.settings-routing-row[data-routing-draft="1"]') as {
      querySelector: (s: string) => { value: string; dispatchEvent: (e: unknown) => void };
    };
    expect(draft).toBeTruthy();
    const keywords = draft.querySelector(".settings-routing-keywords");
    keywords.value = "grep, map";
    keywords.dispatchEvent(new window.Event("input"));
    keywords.dispatchEvent(new window.Event("blur"));
    // Words but no companion yet: still a draft, still nothing posted.
    expect(routingSaves(posted)).toHaveLength(0);
    const again = q(document, '.settings-routing-row[data-routing-draft="1"]') as {
      querySelector: (s: string) => { value: string; dispatchEvent: (e: unknown) => void };
    };
    const provider = again.querySelector('[data-routing-field="provider"]');
    provider.value = "gemini";
    provider.dispatchEvent(new window.Event("change"));
    expect(routingSaves(posted).at(-1)!.rules).toEqual([
      { match: ["grep", "map"], provider: "gemini", model: "", effort: "" },
    ]);
  });

  it("discards a draft rule without writing anything", () => {
    const { root, posted } = mount();
    (q(root, ".settings-routing-new") as { click: () => void }).click();
    (q(document, '.settings-routing-row[data-routing-draft="1"] .settings-routing-remove') as { click: () => void }).click();
    expect(q(document, '.settings-routing-row[data-routing-draft="1"]')).toBeNull();
    expect(routingSaves(posted)).toHaveLength(0);
  });

  it("saves keywords on blur rather than on every keystroke", () => {
    // Each save is a settings write; one per character would fight the user's
    // own typing.
    const { window, root, posted } = mount({ subagentRouting: [rule()] });
    const keywords = q(root, ".settings-routing-keywords") as {
      value: string;
      dispatchEvent: (e: unknown) => void;
    };
    keywords.value = "grep, map";
    keywords.dispatchEvent(new window.Event("input"));
    expect(routingSaves(posted)).toHaveLength(0);
    keywords.dispatchEvent(new window.Event("blur"));
    expect((routingSaves(posted).at(-1)!.rules as { match: string[] }[])[0].match)
      .toEqual(["grep", "map"]);
  });

  it("drops a model that belonged to the old companion when the target changes", () => {
    // A model id means nothing next to a companion that does not have it.
    const { window, root, posted } = mount({ subagentRouting: [rule({ model: "m-fast" })] });
    const select = (qa(root, ".settings-routing-row select") as {
      value: string;
      dispatchEvent: (e: unknown) => void;
    }[])[0];
    select.value = "claude";
    select.dispatchEvent(new window.Event("change"));
    const saved = (routingSaves(posted).at(-1)!.rules as { provider: string; model: string }[])[0];
    expect(saved).toMatchObject({ provider: "claude", model: "" });
  });

  it("offers only the chosen companion's own models", () => {
    const { root } = mount({ subagentRouting: [rule({ provider: "gemini" })] });
    const modelSelect = (qa(root, ".settings-routing-row select") as {
      options: { value: string }[];
    }[])[1];
    const values = Array.from(modelSelect.options).map((option) => option.value);
    expect(values).toContain("m-fast");
    expect(values).not.toContain("m-strong");
  });

  it("moves a rule up, because order is precedence", () => {
    const { root, posted } = mount({
      subagentRouting: [rule({ match: ["first"] }), rule({ match: ["second"] })],
    });
    const moves = qa(root, ".settings-routing-move") as { click: () => void; disabled: boolean }[];
    // The top rule has nowhere to go.
    expect(moves[0].disabled).toBe(true);
    moves[1].click();
    const order = (routingSaves(posted).at(-1)!.rules as { match: string[] }[]).map((r) => r.match[0]);
    expect(order).toEqual(["second", "first"]);
  });

  it("removes a rule", () => {
    const { root, posted } = mount({
      subagentRouting: [rule({ match: ["a"] }), rule({ match: ["b"] })],
    });
    (qa(root, ".settings-routing-remove") as { click: () => void }[])[0].click();
    const remaining = (routingSaves(posted).at(-1)!.rules as { match: string[] }[]).map((r) => r.match[0]);
    expect(remaining).toEqual(["b"]);
  });

  it("shows no header row when there is nothing to head", () => {
    const { root } = mount();
    expect(q(root, ".settings-routing-head")).toBeNull();
  });
});

describe("The subagent roster (AP-16 §6.2)", () => {
  // P2 shipped this table with its listeners attached during render, where
  // `post` is not in scope and a repaint throws them away — so no edit ever
  // reached the host. Nothing covered it until P6 added a settings DOM test.
  const rosterRow = (over: Record<string, unknown> = {}) => ({
    id: "gemini",
    label: "Google Antigravity",
    status: "usable",
    enabled: true,
    allowWrite: true,
    allowedModels: [],
    defaultModel: "",
    defaultEffort: "",
    maxEffort: "",
    notes: "",
    ...over,
  });

  const rosterSaves = (posted: Record<string, unknown>[]) =>
    posted.filter((m) => m.type === "subagentRosterSave");

  it("turns a companion off", () => {
    const { window, root, posted } = mount({ subagentRoster: [rosterRow()] });
    const toggle = q(root, '[role="switch"][data-roster-field="enabled"]') as { click: () => void };
    toggle.click();
    expect(rosterSaves(posted).at(-1)).toMatchObject({
      provider: "gemini",
      patch: { enabled: false },
    });
  });

  it("sets a default model from the companion's own cache", () => {
    const { window, root, posted } = mount({ subagentRoster: [rosterRow()] });
    const select = q(root, '[data-roster-field="defaultModel"]') as {
      value: string;
      dispatchEvent: (e: unknown) => void;
    };
    select.value = "m-fast";
    select.dispatchEvent(new window.Event("change"));
    expect(rosterSaves(posted).at(-1)).toMatchObject({ patch: { defaultModel: "m-fast" } });
  });

  it("saves the notes on blur, and only when they changed", () => {
    const { window, root, posted } = mount({ subagentRoster: [rosterRow({ notes: "fast" })] });
    const notes = q(root, '[data-roster-field="notes"]') as {
      value: string;
      dispatchEvent: (e: unknown) => void;
    };
    // Tabbing through without editing must not write the same note back.
    notes.dispatchEvent(new window.Event("blur"));
    expect(rosterSaves(posted)).toHaveLength(0);
    notes.value = "fast and cheap, good for repo scans";
    notes.dispatchEvent(new window.Event("blur"));
    expect(rosterSaves(posted).at(-1)).toMatchObject({
      patch: { notes: "fast and cheap, good for repo scans" },
    });
  });

  it("says which companions are signed in and which are not", () => {
    const { root } = mount({
      subagentRoster: [rosterRow(), rosterRow({ id: "claude", label: "Claude Code", status: "needs-login" })],
    });
    const panel = q(root, ".settings-roster") as { textContent: string };
    expect(panel.textContent).toContain("Usable");
    expect(panel.textContent).toContain("Needs login");
  });
});

describe("Crew stages may use subagents (§7.9)", () => {
  it("is off by default and says why", () => {
    const { root } = mount();
    const row = qa(root, ".settings-row").find(
      (el) => (el as { dataset: { id: string } }).dataset.id === "crewStageSubagents",
    ) as { textContent: string } | undefined;
    expect(row).toBeTruthy();
    expect(row!.textContent).toContain("a run inside a run is harder to follow");
  });

  it("posts the toggle rather than writing the setting itself", () => {
    const { root, posted } = mount({ crewStagesMayUseSubagents: false });
    const row = qa(root, ".settings-row").find(
      (el) => (el as { dataset: { id: string } }).dataset.id === "crewStageSubagents",
    ) as { querySelector: (s: string) => { click: () => void } };
    row.querySelector("button, input[type=checkbox]")!.click();
    expect(posted.some((m) => m.type === "setCrewStageSubagents" && m.value === true)).toBe(true);
  });
});
