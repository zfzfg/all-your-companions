/**
 * The Routines page — the settings surface half of the feature.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *   1. The collapsed row answers "healthy / when next" without being opened:
 *      it carries the strip and a countdown, and NOT the prompt
 *   2. The strip encodes outcome in class as well as colour, oldest run left
 *   3. A run that opened a session is clickable; a skipped one is not
 *   4. Opening a row reveals the form; the chevron toggles it back
 *   5. The days cadence grows a time control and minutes/hours do not
 *   6. Saving posts the edited draft, not the original values
 *   7. Remove takes two clicks, and the second one says what it does
 *   8. Pause posts the inverse of the current state
 *   9. Clicking a run posts resumeSession with the routine's cwd
 *  10. Opening the category asks the host for the list exactly once
 *  11. The empty state invites rather than announcing emptiness
 *  12. An archived project stays selectable and says so
 *  13. The countdown floors and never claims more time than is left
 */
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const settingsSrc = readFileSync(
  fileURLToPath(new URL("../media/settings.js", import.meta.url)),
  "utf8",
);
const settingsCss = readFileSync(
  fileURLToPath(new URL("../media/settings.css", import.meta.url)),
  "utf8",
);

const NOW = Date.UTC(2026, 7, 24, 12, 0);

function routine(over: Record<string, unknown> = {}) {
  return {
    id: "r1",
    title: "Morning brief",
    prompt: "Summarise what changed.",
    cwd: "C:/repo",
    provider: "grok",
    model: "grok-4.6",
    cadence: { every: 6, unit: "hours" },
    createdAt: NOW - 3600_000,
    cadenceLabel: "Every 6 hours",
    // RELATIVE to real time, not to the fixed NOW below. The countdown is
    // rendered against `Date.now()`, so a pinned timestamp quietly expires —
    // this test passed all morning and started failing at 12:42 UTC.
    nextRunAt: Date.now() + 42 * 60_000,
    projectLabel: "grok-remote",
    // Newest first, as the host sends them. Three DIFFERENT outcomes on
    // purpose: a symmetric fixture cannot tell a reversed strip from a correct
    // one, and the first version of this test could not.
    runs: [
      { routineId: "r1", windowKey: "i2", startedAt: NOW - 1000, outcome: "ran", sessionId: "s-2" },
      { routineId: "r1", windowKey: "i1", startedAt: NOW - 2000, outcome: "skipped", detail: "Skipped — Claude was not connected" },
      { routineId: "r1", windowKey: "i0", startedAt: NOW - 3000, outcome: "failed", detail: "Failed — the agent could not start" },
    ],
    health: { ran: 1, skipped: 1, failed: 1, total: 3 },
    ...over,
  };
}

function boot(snapshotOver: Record<string, unknown> = {}) {
  const window = new Window({ url: "https://localhost/" });
  (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
  const api = (window as unknown as { GrokSettings: Record<string, any> }).GrokSettings;
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const posted: Array<Record<string, unknown>> = [];
  const env = api.defaultEnv({ isDesktop: true, providersKnown: true });
  const baseSnapshot = (over: Record<string, unknown>) => api.defaultSnapshot({
    routineProjects: [
      { cwd: "C:/repo", label: "grok-remote" },
      { cwd: "C:/old", label: "notes", archived: true },
    ],
    routineModels: [
      { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
      { provider: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
    ],
    ...over,
  });
  const surface = api.mount(root, {
    snapshot: api.defaultSnapshot({
      routineProjects: [
        { cwd: "C:/repo", label: "grok-remote" },
        { cwd: "C:/old", label: "notes", archived: true },
      ],
      routineModels: [
        { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
        { provider: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
      ],
      ...snapshotOver,
    }),
    env: api.defaultEnv({ isDesktop: true, providersKnown: true }),
    standalone: true,
    category: "routines",
    post: (msg: Record<string, unknown>) => posted.push(msg),
  });
  /** Push a new snapshot exactly as chat.js does after a host frame arrives. */
  const update = (over: Record<string, unknown>) => surface.update(baseSnapshot(over), env);
  return { api, doc, root, posted, window, update };
}

function click(el: Element | null): void {
  if (!el) throw new Error("nothing to click");
  (el as HTMLElement).click();
}

describe("the collapsed row", () => {
  it("carries health and a countdown, and not the prompt (req 1)", () => {
    const { root } = boot({ routines: [routine()] });
    const card = root.querySelector(".settings-routine");
    expect(card).toBeTruthy();
    expect(root.querySelector(".settings-routine-name")?.textContent).toContain("Morning brief");
    expect(root.querySelector(".settings-routine-meta")?.textContent).toContain("Every 6 hours");
    expect(root.querySelector(".settings-routine-meta")?.textContent).toContain("grok-remote");
    expect(root.querySelector(".settings-routine-strip")).toBeTruthy();
    expect(root.querySelector(".settings-routine-next")?.textContent).toMatch(/^in \d/);
    // The prompt is what you edit, not what you check.
    expect(root.textContent).not.toContain("Summarise what changed.");
    expect(root.querySelector(".settings-routine-body")).toBeNull();
  });

  it("encodes each outcome in a class, oldest first (req 2)", () => {
    const { root } = boot({ routines: [routine()] });
    const ticks = [...root.querySelectorAll(".settings-routine-tick")];
    expect(ticks).toHaveLength(3);
    // Data arrives newest-first; the strip reads left-to-right in time.
    expect(ticks.map((t) => t.className.split(" ").pop())).toEqual([
      "is-failed", "is-skipped", "is-ran",
    ]);
    expect(root.querySelector(".settings-routine-count")?.textContent).toBe("1/3");
  });

  it("makes only a run with a session clickable (req 3)", () => {
    const { root } = boot({ routines: [routine()] });
    const ticks = [...root.querySelectorAll(".settings-routine-tick")];
    // Oldest (failed) and the skip carry no session; the newest run does.
    expect(ticks[0].getAttribute("data-session")).toBeNull();
    expect(ticks[1].getAttribute("data-session")).toBeNull();
    expect(ticks[2].getAttribute("data-session")).toBe("s-2");
    expect(ticks[1].getAttribute("aria-label")).toContain("Claude was not connected");
  });

  it("says paused instead of a countdown when it is", () => {
    const { root } = boot({ routines: [routine({ paused: true })] });
    expect(root.querySelector(".settings-routine-next")?.textContent).toBe("Paused");
    expect(root.querySelector(".settings-routine")?.className).toContain("is-paused");
  });
});

describe("expanding", () => {
  it("reveals the form and toggles back (req 4)", () => {
    const { root } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    expect(root.querySelector(".settings-routine-body")).toBeTruthy();
    expect((root.querySelector('[data-field="prompt"]') as HTMLTextAreaElement).value).toBe(
      "Summarise what changed.",
    );
    expect(root.querySelector(".settings-routine")?.className).toContain("is-open");

    click(root.querySelector(".settings-routine-toggle"));
    expect(root.querySelector(".settings-routine-body")).toBeNull();
  });

  it("grows a time control only on days (req 5)", () => {
    const { root } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    expect(root.querySelector('[data-field="at"]')).toBeNull();

    const unit = root.querySelector('[data-field="unit"]') as HTMLSelectElement;
    unit.value = "days";
    unit.dispatchEvent(new (root.ownerDocument.defaultView as any).Event("change", { bubbles: true }));

    const at = root.querySelector('[data-field="at"]') as HTMLInputElement;
    expect(at).toBeTruthy();
    expect(at.type).toBe("time");
  });

  it("lists an archived project as selectable and marked (req 12)", () => {
    const { root } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    const options = [...root.querySelectorAll('[data-field="cwd"] option')].map(
      (o) => o.textContent,
    );
    expect(options).toContain("notes (archived)");
  });
});

describe("writing", () => {
  it("posts the edited draft, not the original (req 6)", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));

    const title = root.querySelector('[data-field="title"]') as HTMLInputElement;
    title.value = "Evening brief";
    title.dispatchEvent(new (root.ownerDocument.defaultView as any).Event("input", { bubbles: true }));

    click(root.querySelector(".settings-routine-save"));
    const save = posted.find((m) => m.type === "saveRoutine") as any;
    expect(save).toBeTruthy();
    expect(save.id).toBe("r1");
    expect(save.draft.title).toBe("Evening brief");
    expect(save.draft.prompt).toBe("Summarise what changed.");
    expect(save.draft.cadence).toEqual({ every: 6, unit: "hours" });
  });

  it("sends a time only when the unit is days", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    const unit = root.querySelector('[data-field="unit"]') as HTMLSelectElement;
    unit.value = "days";
    unit.dispatchEvent(new (root.ownerDocument.defaultView as any).Event("change", { bubbles: true }));
    click(root.querySelector(".settings-routine-save"));
    const save = posted.find((m) => m.type === "saveRoutine") as any;
    expect(save.draft.cadence.unit).toBe("days");
    expect(save.draft.cadence.at).toBe("09:00");
  });

  it("takes two clicks to remove, and says so on the second (req 7)", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));

    click(root.querySelector(".settings-routine-remove"));
    expect(posted.some((m) => m.type === "deleteRoutine")).toBe(false);
    expect(root.querySelector(".settings-routine-remove")?.textContent).toBe("Remove for good");

    click(root.querySelector(".settings-routine-remove"));
    expect(posted.find((m) => m.type === "deleteRoutine")).toEqual({
      type: "deleteRoutine",
      id: "r1",
    });
  });

  it("posts the inverse of the current paused state (req 8)", () => {
    const running = boot({ routines: [routine()] });
    click(running.root.querySelector(".settings-routine-toggle"));
    click(running.root.querySelector(".settings-routine-pause"));
    expect(running.posted.find((m) => m.type === "setRoutinePaused")).toEqual({
      type: "setRoutinePaused", id: "r1", paused: true,
    });

    const paused = boot({ routines: [routine({ paused: true })] });
    click(paused.root.querySelector(".settings-routine-toggle"));
    expect(paused.root.querySelector(".settings-routine-pause")?.textContent).toBe("Resume");
    click(paused.root.querySelector(".settings-routine-pause"));
    expect(paused.posted.find((m) => m.type === "setRoutinePaused")).toEqual({
      type: "setRoutinePaused", id: "r1", paused: false,
    });
  });

  it("fires an explicit run", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    click(root.querySelector(".settings-routine-run-now"));
    expect(posted.find((m) => m.type === "runRoutineNow")).toEqual({
      type: "runRoutineNow", id: "r1",
    });
  });

  it("shows a refusal against the routine it belongs to", () => {
    const { root } = boot({
      routines: [routine()],
      routineError: "Routines run at most once every 15 minutes.",
      routineErrorId: "r1",
    });
    click(root.querySelector(".settings-routine-toggle"));
    expect(root.querySelector(".settings-routine-error")?.textContent).toBe(
      "Routines run at most once every 15 minutes.",
    );
  });
});

describe("opening a run", () => {
  it("posts resumeSession with the routine's project (req 9)", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    click(root.querySelector(".settings-routine-open"));
    expect(posted.find((m) => m.type === "resumeSession")).toEqual({
      type: "resumeSession", id: "s-2", cwd: "C:/repo", claim: true,
    });
  });

  it("does the same from a tick in the strip", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector('.settings-routine-tick[data-session]'));
    expect(posted.find((m) => m.type === "resumeSession")).toBeTruthy();
  });
});

describe("the page as a whole", () => {
  it("asks the host for the list exactly once (req 10)", () => {
    const { posted, root } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    expect(posted.filter((m) => m.type === "listRoutines")).toHaveLength(1);
  });

  it("repaints when the frame lands, not when the reader next touches the page", () => {
    // A deferred paint waited for exactly one event — the nav select losing
    // focus — but `navMenuOpen` is true whenever that select merely HAS focus,
    // and picking a category leaves it focused. So on a phone the routines
    // frame arrived, was deferred, and nothing flushed it: "Loading routines…"
    // until the reader touched the screen for an unrelated reason. Pre-existing;
    // the connectors page did the same with its own loading line.
    const window = new Window({ url: "https://localhost/" });
    // settings.js is evaluated inside this window, so its setTimeout is the
    // window's — Node's fake timers never see it. Capture the callbacks here
    // and fire them by hand.
    const pending: Array<() => void> = [];
    (window as any).setTimeout = (fn: () => void) => { pending.push(fn); return pending.length; };
    (window as any).clearTimeout = () => {};
    // The nav collapses into a <select> only under the phone media query, which
    // happy-dom answers false for by default — so the deferral this test is
    // about could never be reached without saying otherwise.
    (window as any).matchMedia = () => ({
      matches: true, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {},
    });
    (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
    const api = (window as unknown as { GrokSettings: Record<string, any> }).GrokSettings;
    const doc = window.document as unknown as Document;
    const root = doc.createElement("div");
    doc.body.appendChild(root);
    const env = api.defaultEnv({ isDesktop: false, providersKnown: true });
    const surface = api.mount(root, {
      snapshot: api.defaultSnapshot({}),
      env, standalone: true, category: "routines", post: () => {},
    });

    const select = root.querySelector(".settings-nav-select") as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    select!.focus();

    surface.update(api.defaultSnapshot({ routines: [routine()] }), env);
    // Deferred while the select holds focus — that part is deliberate.
    expect(root.querySelector(".settings-routines-loading")).toBeTruthy();

    // Choosing a category closes the dropdown, and that must flush.
    // And with NO interaction at all — which is the reported case, since the
    // reader is just looking at the page — the backstop must still flush it.
    // Touching the screen used to be the only way out.
    expect(pending.length, "deferring must arm a backstop").toBeGreaterThan(0);
    pending.forEach((fn) => fn());
    expect(root.querySelector(".settings-routines-loading")).toBeNull();
    expect(root.querySelector(".settings-routine-name")?.textContent).toContain("Morning brief");
  });

  it("waits rather than claiming there are none (noticed on remote)", () => {
    // The empty state is an invitation — "create your first routine". Showing
    // it before the host has answered tells the reader something false at the
    // one moment they are deciding what to do, and on a phone the frame takes
    // long enough to see. Empty and unknown are different states.
    const { root, update } = boot();
    expect(root.querySelector(".settings-routines-loading")).toBeTruthy();
    expect(root.textContent).not.toContain("No routines yet");
    expect(root.querySelector(".settings-routine-new")).toBeNull();

    update({ routines: [] });
    expect(root.querySelector(".settings-routines-loading")).toBeNull();
    expect(root.textContent).toContain("No routines yet");
  });

  it("invites rather than announcing emptiness (req 11)", () => {
    const { root, posted } = boot({ routines: [] });
    const copy = root.querySelector(".settings-routines-empty-copy")?.textContent || "";
    expect(copy).toContain("morning summary");
    expect(copy).toContain("last twenty");
    click(root.querySelector(".settings-routine-new"));
    expect(root.querySelector(".settings-routine.is-new")).toBeTruthy();
    // A brand-new routine defaults to the first project and model rather than
    // to nothing, so the form is savable without touching every field.
    expect((root.querySelector('[data-field="cwd"]') as HTMLSelectElement).value).toBe("C:/repo");
    click(root.querySelector(".settings-routine-save"));
    const save = posted.find((m) => m.type === "saveRoutine") as any;
    expect(save.id).toBeUndefined();
    expect(save.draft.provider).toBe("grok");
  });

  it("names the host the reader is actually looking at", () => {
    // "a window is open" named nothing the reader controls.
    const { root, api } = boot({ routines: [routine()] });
    expect(root.querySelector(".settings-routines-note")?.textContent).toContain("this app");

    expect(api.routinesHostNote({ isDesktop: true })).toContain("this app or an editor window");
    expect(api.routinesHostNote({ isDesktop: false })).toContain("this IDE or the desktop app");
  });
});

describe("the countdown", () => {
  it("floors and never overstates the time left (req 13)", () => {
    const { api } = boot();
    const f = api.formatRoutineCountdown;
    expect(f(0)).toBe("due now");
    expect(f(-5000)).toBe("due now");
    expect(f(59_000)).toBe("in 1m");
    expect(f(42 * 60_000)).toBe("in 42m");
    expect(f(59 * 60_000 + 59_000)).toBe("in 59m");
    expect(f(60 * 60_000)).toBe("in 1h");
    expect(f(6 * 3600_000 + 12 * 60_000)).toBe("in 6h 12m");
    expect(f(23 * 3600_000 + 59 * 60_000)).toBe("in 23h 59m");
    expect(f(24 * 3600_000)).toBe("in 1d");
    expect(f(3 * 24 * 3600_000 + 4 * 3600_000)).toBe("in 3d 4h");
  });

  it("names a skip by its reason and a plain run by its outcome", () => {
    const { api } = boot();
    expect(api.routineRunLabel({ outcome: "ran" })).toBe("Ran");
    expect(api.routineRunLabel({ outcome: "running" })).toBe("Running now");
    expect(api.routineRunLabel({ outcome: "skipped", detail: "Skipped — no model" })).toBe(
      "Skipped — no model",
    );
    expect(api.routineRunLabel({ outcome: "failed" })).toBe("Failed");
  });
});

describe("the surfaces this page has to reach", () => {
  // The Routines page renders in the chat overlay and in the standalone VS Code
  // Settings tab. The render was copied from the connectors catalog; the
  // ROUTING registration was not, and each surface has a separate list that has
  // to name the message or the surface goes dark.
  const sidebarSrc = readFileSync(
    fileURLToPath(new URL("../src/sidebar.ts", import.meta.url)),
    "utf8",
  );
  const htmlSrc = readFileSync(
    fileURLToPath(new URL("../src/webview-html.ts", import.meta.url)),
    "utf8",
  );
  const routineSchedulerSrc = readFileSync(
    fileURLToPath(new URL("../src/routine-scheduler.ts", import.meta.url)),
    "utf8",
  );

  function block(marker: string, terminator = "]);"): string {
    const source = marker.includes("SETTINGS_PANEL_TYPES") ? readFileSync(new URL("../src/sidebar-view-host.ts", import.meta.url), "utf8") : sidebarSrc;
    const start = source.indexOf(marker);
    expect(start, marker).toBeGreaterThan(-1);
    const end = source.indexOf(terminator, start);
    expect(end, marker).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it("the standalone Settings tab LISTENS for the routines frame", () => {
    // Fifth hand-written registry the same message type has to be named in, and
    // TypeScript enforces none of them. The tab renders settings.js with its own
    // inline listener; a type missing there is received and silently dropped, so
    // the page sat on "Loading routines…" for ever. Pre-existing — before the
    // loading state it defaulted to [] and merely lied about having none.
    const start = htmlSrc.indexOf('window.addEventListener("message"');
    expect(start).toBeGreaterThan(-1);
    const listener = htmlSrc.slice(start, htmlSrc.indexOf("settingsCategory", start) + 40);
    // The EXACT conditional, not just the string: a dead branch such as
    // `false && msg.type === "routines"` still contains the substring.
    expect(listener).toContain('if (msg.type === "routines") {');
    expect(listener).toContain("routineProjects");
    expect(listener).toContain("routineModels");
    // A refused save is answered with an error frame and nothing else.
    expect(listener).toContain('if (msg.type === "error") {');
  });

  it("accepts every routine message from the standalone Settings tab", () => {
    // That tab loads settings.js and nothing else. Anything missing here is
    // answered with "[settings] ignored <type>" and the page cannot function.
    const body = block("private static readonly SETTINGS_PANEL_TYPES");
    for (const type of ["listRoutines", "saveRoutine", "deleteRoutine", "setRoutinePaused", "runRoutineNow"]) {
      expect(body, type).toContain(`"${type}"`);
    }
  });

  it("does not report a failed turn as a successful run", () => {
    // `handleSend` catches a failed turn, renders the error and resolves
    // normally, so awaiting it says nothing about whether the turn worked.
    // Without this check a rate-limited run gets a green tick — the exact lie
    const start = routineSchedulerSrc.indexOf("public async runRoutine(");
    const body = routineSchedulerSrc.slice(start, routineSchedulerSrc.indexOf("\n  }\n}", start));
    expect(body).toContain('session.status === "error"');
    expect(body).not.toMatch(/finish\("ran"\)/);
  });

  it("gates a run on the PROVIDER, never on an exact model", () => {
    // The model list's contents change with cache state: a provider with no
    // cached models offers one empty-modelId sentinel, and after discovery it
    // offers concrete rows instead. Matching a saved routine against that list
    // meant a "Grok default" routine ran once and then skipped for ever,
    // reporting a provider that was connected as not connected.
    const start = routineSchedulerSrc.indexOf("public async runRoutine(");
    const body = routineSchedulerSrc.slice(start, routineSchedulerSrc.indexOf("\n  }\n}", start));
    expect(body).toContain("this.deps.usableProviders().includes(routine.provider)");
    expect(body).not.toMatch(/models\.some\(\(m\) =>[^)]*routine\.model/);
  });

  it("offers the agent default whether or not models were discovered", () => {
    const body = block("private routineModelOptions()", "\n  }");
    expect(body).toContain('model: ""');
    expect(body).toContain("default");
    // Not conditional on an empty cache.
    expect(body).not.toContain("if (!cache");
  });

  it("posts the page to the chat webview and the settings tab", () => {
    const body = block("private postRoutines(): void", "\n  }");
    expect(body).toContain("this.postLocal(message)");
    expect(body).toContain("this.settingsEditor?.webview.postMessage");
  });
});

describe("a run remembers its own project", () => {
  it("links through the run's cwd, not the routine's current one (finding 6)", () => {
    // Repointing a routine at another project must not break the links to what
    // already ran there.
    const moved = routine({ cwd: "C:/new-project" });
    moved.runs = [
      { routineId: "r1", windowKey: "i2", startedAt: Date.now(), outcome: "ran", sessionId: "s-2", cwd: "C:/repo" },
    ] as never;
    const { root, posted } = boot({ routines: [moved] });
    click(root.querySelector(".settings-routine-toggle"));
    click(root.querySelector(".settings-routine-open"));
    expect(posted.find((m) => m.type === "resumeSession")).toEqual({
      type: "resumeSession", id: "s-2", cwd: "C:/repo", claim: true,
    });
  });

  it("falls back to the routine's project for a run recorded before this existed", () => {
    const { root, posted } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    click(root.querySelector(".settings-routine-open"));
    expect((posted.find((m) => m.type === "resumeSession") as any).cwd).toBe("C:/repo");
  });
});

describe("things only a real layout engine caught", () => {
  // All three shipped past the DOM tests in this file, because happy-dom has no
  // layout: it will not tell you a control clipped, a label wrapped, or that a
  // grid meant for one element is being applied to another.
  it("gives Run now a class the run-log grid cannot claim", () => {
    // Both the button and each log ROW were `.settings-routine-run`, so the
    // row's `grid-template-columns: 10px 104px …` laid out the button and split
    // "Run now" across two cells.
    const { root } = boot({ routines: [routine()] });
    click(root.querySelector(".settings-routine-toggle"));
    const btn = root.querySelector(".settings-routine-run-now");
    expect(btn).toBeTruthy();
    expect(btn!.className).not.toMatch(/settings-routine-run(\s|$)/);
    expect(settingsCss).toMatch(/\.settings-routine-foot \.settings-action\s*\{[^}]*white-space:\s*nowrap/s);
  });

  it("keeps the time control from being squeezed below its own text", () => {
    // `.settings-routine-input` sets min-width: 0, which inside the cadence
    // flex row let "09:00 AM" and its clock icon clip on a narrow window.
    expect(settingsCss).toMatch(/\.settings-routine-time\s*\{[^}]*flex:\s*0 0 auto/s);
    expect(settingsCss).toMatch(/\.settings-routine-time\s*\{[^}]*min-width:\s*8\.5rem/s);
  });
});

describe("creating a routine", () => {
  it("closes the form once the host confirms the save", () => {
    // Left open with the same text, the obvious next act is to press Create
    // again — and that is a duplicate routine on a schedule.
    const { root, update } = boot({ routines: [] });
    click(root.querySelector(".settings-routine-new"));
    expect(root.querySelector(".settings-routine.is-new")).toBeTruthy();
    click(root.querySelector(".settings-routine-save"));

    // The host answers every write with a fresh frame; one with no error means
    // the write landed.
    update({ routines: [routine()] });
    expect(root.querySelector(".settings-routine.is-new")).toBeNull();
  });

  it("keeps the form open when the host refuses", () => {
    const { root, update } = boot({ routines: [] });
    click(root.querySelector(".settings-routine-new"));
    const title = root.querySelector('[data-field="title"]') as HTMLInputElement;
    title.value = "Too fast";
    title.dispatchEvent(new (root.ownerDocument.defaultView as any).Event("input", { bubbles: true }));
    click(root.querySelector(".settings-routine-save"));

    update({
      routines: [],
      routineError: "Routines run at most once every 15 minutes.",
    });
    expect(root.querySelector(".settings-routine.is-new")).toBeTruthy();
    expect(root.textContent).toContain("Routines run at most once every 15 minutes.");
  });
});

describe("the model picker", () => {
  it("groups by provider", () => {
    const { root } = boot({
      routines: [],
      routineModels: [
        { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
        { provider: "grok", model: "grok-4.6-fast", label: "Grok 4.6 Fast" },
        { provider: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
      ],
    });
    click(root.querySelector(".settings-routine-new"));
    const groups = [...root.querySelectorAll('[data-field="model"] optgroup')];
    expect(groups.map((g) => g.getAttribute("label"))).toEqual(["Grok", "Claude"]);
    expect(groups[0].querySelectorAll("option")).toHaveLength(2);
  });

  it("shows one group per provider, not one per run of options", () => {
    // The host sends "<X> default" then that provider's models, per provider.
    // Sending all the defaults first put every provider in the list twice, and
    // the picker grouped by consecutive provider — six headings for three
    // agents, which is what the owner saw.
    const { root } = boot({
      routines: [],
      routineModels: [
        { provider: "grok", model: "", label: "Grok default" },
        { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
        { provider: "claude", model: "", label: "Claude default" },
        { provider: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
      ],
    });
    click(root.querySelector(".settings-routine-new"));
    const labels = [...root.querySelectorAll('[data-field="model"] optgroup')]
      .map((g) => g.getAttribute("label"));
    expect(labels).toEqual(["Grok", "Claude"]);
  });

  it("hides the empty-model row beside real models, as the composer does", () => {
    const { root } = boot({
      routines: [],
      routineModels: [
        { provider: "grok", model: "", label: "Grok default" },
        { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
      ],
    });
    click(root.querySelector(".settings-routine-new"));
    const options = [...root.querySelectorAll('[data-field="model"] option')].map((o) => o.textContent);
    expect(options).toEqual(["Grok 4.6"]);
  });

  it("keeps the empty-model row when it is the only thing a provider offers", () => {
    // A fresh host, before anything has opened the model picker.
    const { root } = boot({
      routines: [],
      routineModels: [{ provider: "grok", model: "", label: "Grok default" }],
    });
    click(root.querySelector(".settings-routine-new"));
    const options = [...root.querySelectorAll('[data-field="model"] option')].map((o) => o.textContent);
    expect(options).toEqual(["Grok default"]);
  });

  it("keeps the empty-model row for a routine already saved on it", () => {
    // Otherwise opening such a routine finds no matching option and the select
    // silently re-points it at a concrete model the user never chose.
    const saved = routine({ provider: "grok", model: "" });
    const { root } = boot({
      routines: [saved],
      routineModels: [
        { provider: "grok", model: "", label: "Grok default" },
        { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
      ],
    });
    click(root.querySelector(".settings-routine-toggle"));
    const select = root.querySelector('[data-field="model"]') as HTMLSelectElement;
    expect([...select.querySelectorAll("option")].map((o) => o.textContent))
      .toEqual(["Grok default", "Grok 4.6"]);
    expect(select.value).toBe("grok ");
  });

  it("starts on the project's default provider, like the composer", () => {
    const { root } = boot({
      routines: [],
      routineProjects: [{ cwd: "C:/repo", label: "repo", defaultProvider: "claude" }],
      routineModels: [
        { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
        { provider: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
      ],
    });
    click(root.querySelector(".settings-routine-new"));
    // Not simply the first model in the list — the one this project would use.
    expect((root.querySelector('[data-field="model"]') as HTMLSelectElement).value)
      .toBe("claude claude-opus-5");
  });

  it("re-picks the model when the project changes", () => {
    const { root } = boot({
      routines: [],
      routineProjects: [
        { cwd: "C:/a", label: "a", defaultProvider: "grok" },
        { cwd: "C:/b", label: "b", defaultProvider: "claude" },
      ],
      routineModels: [
        { provider: "grok", model: "grok-4.6", label: "Grok 4.6" },
        { provider: "claude", model: "claude-opus-5", label: "Claude Opus 5" },
      ],
    });
    click(root.querySelector(".settings-routine-new"));
    expect((root.querySelector('[data-field="model"]') as HTMLSelectElement).value)
      .toBe("grok grok-4.6");

    const project = root.querySelector('[data-field="cwd"]') as HTMLSelectElement;
    project.value = "C:/b";
    project.dispatchEvent(new (root.ownerDocument.defaultView as any).Event("change", { bubbles: true }));
    expect((root.querySelector('[data-field="model"]') as HTMLSelectElement).value)
      .toBe("claude claude-opus-5");
  });
});

describe("style pins", () => {
  it("carries run state in shape as well as hue", () => {
    // A greyscale screenshot and a colourblind reader both have to be able to
    // tell these apart, so height and width do the work colour alone cannot.
    expect(settingsCss).toMatch(/\.settings-routine-tick\.is-skipped\s*\{[^}]*height:\s*40%/s);
    expect(settingsCss).toMatch(/\.settings-routine-tick\.is-failed[^{]*\{[^}]*width:\s*5px/s);
    expect(settingsCss).toMatch(/\.settings-routine-tick:last-child\s*\{[^}]*box-shadow/s);
  });

  it("respects reduced motion on the chevron", () => {
    expect(settingsCss).toMatch(
      /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.settings-routine-chev\s*\{\s*transition:\s*none/s,
    );
  });

  it("gives the row a visible keyboard focus state", () => {
    expect(settingsCss).toMatch(
      /button\.settings-routine-head:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--vscode-focusBorder\)/s,
    );
  });
});
