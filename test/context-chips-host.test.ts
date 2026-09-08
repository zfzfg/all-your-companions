/**
 * AP-03, host half: the two moments a context chip touches the outside world.
 *
 *   ATTACH — probe the source, refuse an empty one, stage metadata only.
 *   SEND   — read the source AGAIN and hand the fresh bytes to the builder.
 *
 * The split is the feature, so the tests that matter most here are the ones
 * that prove nothing travels between the two: a chip staged when the workspace
 * was clean must send the problems a build has since produced, and a chip
 * staged at twelve problems must not send twelve when nine are left.
 *
 * Fault injection is the other half. `vscode.languages.getDiagnostics` and the
 * terminal capture are the host facade's edge; a throw there must cost the chip
 * (with something said), never the composer or the turn.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { isDiagnosticsChip, isTerminalChip, type ContextChip } from "../src/context-chips";
import type { HostDiagnostic, HostDiagnosticsScope, HostTerminalCapture } from "../src/host";

type FakeHost = {
  getDiagnostics: (scope: HostDiagnosticsScope) => HostDiagnostic[];
  getTerminalCapture: () => HostTerminalCapture | undefined;
  appendLine: ReturnType<typeof vi.fn>;
};

function problem(over: Partial<HostDiagnostic> = {}): HostDiagnostic {
  return {
    path: "src/a.ts",
    line: 12,
    column: 4,
    severity: "error",
    message: "Cannot find name 'foo'.",
    source: "ts",
    ...over,
  };
}

function makeSidebar(host: Partial<FakeHost> = {}) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = { chips: [] as ContextChip[] };
  sidebar.postChips = vi.fn();
  sidebar.reportRequester = vi.fn();
  sidebar.host = {
    getDiagnostics: () => [],
    getTerminalCapture: () => undefined,
    appendLine: vi.fn(),
    ...host,
  };
  return { sidebar, session, owner: () => session };
}

describe("attaching @problems", () => {
  it("stages a chip carrying the count and nothing else", () => {
    const { sidebar, session } = makeSidebar({
      getDiagnostics: () => [problem(), problem({ line: 20, severity: "warning" })],
    });
    sidebar.addContextSourceChip("problems", () => session);

    expect(session.chips.length).toBe(1);
    const chip = session.chips[0];
    if (!isDiagnosticsChip(chip)) throw new Error("expected a diagnostics chip");
    expect(chip.scope).toBe("workspace");
    expect(chip.count).toBe(2);
    expect(chip.hidden).toBe(false);
    // The bytes are NOT on the chip. If they ever are, the send is stale by
    // construction and no later test can save it.
    expect(Object.keys(chip)).not.toContain("items");
    expect(Object.keys(chip)).not.toContain("text");
    expect(sidebar.postChips).toHaveBeenCalledWith(session);
  });

  it("refuses to stage a chip when there is nothing to attach", () => {
    const { sidebar, session } = makeSidebar({ getDiagnostics: () => [] });
    sidebar.addContextSourceChip("problems", () => session);

    expect(session.chips).toEqual([]);
    expect(sidebar.postChips).not.toHaveBeenCalled();
    expect(sidebar.reportRequester).toHaveBeenCalledWith(
      undefined,
      "info",
      expect.stringContaining("No problems reported"),
    );
  });

  it("survives a facade that throws: no chip, a word about it, no crash", () => {
    const { sidebar, session } = makeSidebar({
      getDiagnostics: () => { throw new Error("language service is down"); },
    });
    expect(() => sidebar.addContextSourceChip("problems", () => session)).not.toThrow();

    expect(session.chips).toEqual([]);
    expect(sidebar.reportRequester).toHaveBeenCalledWith(
      undefined,
      "warning",
      expect.stringContaining("Could not read the editor's problems"),
    );
    expect(sidebar.host.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("language service is down"),
    );
  });

  it("drops the attachment when the asking tab is gone", () => {
    // Same rule as addDroppedFile: never redirect an attachment to whatever
    // conversation happens to be focused now.
    const { sidebar } = makeSidebar({ getDiagnostics: () => [problem()] });
    sidebar.addContextSourceChip("problems", () => undefined);
    expect(sidebar.postChips).not.toHaveBeenCalled();
  });
});

describe("attaching @terminal", () => {
  it("stages a chip with the terminal's name and the capture's byte length", () => {
    const { sidebar, session } = makeSidebar({
      getTerminalCapture: () => ({ label: "npm run dev", text: "buildin… done" }),
    });
    sidebar.addContextSourceChip("terminal", () => session);

    const chip = session.chips[0];
    if (!isTerminalChip(chip)) throw new Error("expected a terminal chip");
    expect(chip.label).toBe("npm run dev");
    // UTF-8 bytes, not characters — the ellipsis is three bytes.
    expect(chip.bytes).toBe(Buffer.byteLength("buildin… done", "utf8"));
  });

  it("says WHY there is nothing when the host has captured no output", () => {
    // Shell integration is the precondition, and a user with none would
    // otherwise just see a click that did nothing.
    const { sidebar, session } = makeSidebar({ getTerminalCapture: () => undefined });
    sidebar.addContextSourceChip("terminal", () => session);

    expect(session.chips).toEqual([]);
    expect(sidebar.reportRequester).toHaveBeenCalledWith(
      undefined,
      "info",
      expect.stringContaining("shell integration"),
    );
  });

  it("treats a whitespace-only capture as no capture", () => {
    const { sidebar, session } = makeSidebar({
      getTerminalCapture: () => ({ label: "bash", text: "\n  \n" }),
    });
    sidebar.addContextSourceChip("terminal", () => session);
    expect(session.chips).toEqual([]);
  });

  it("survives a facade that throws", () => {
    const { sidebar, session } = makeSidebar({
      getTerminalCapture: () => { throw new Error("no shell integration"); },
    });
    expect(() => sidebar.addContextSourceChip("terminal", () => session)).not.toThrow();
    expect(session.chips).toEqual([]);
    expect(sidebar.reportRequester).toHaveBeenCalledWith(
      undefined,
      "warning",
      expect.stringContaining("Could not read the terminal"),
    );
  });
});

describe("collecting at SEND, not at attach", () => {
  it("reads the source again — the prompt follows the world, not the chip", () => {
    let problems = [problem()];
    const { sidebar, session } = makeSidebar({ getDiagnostics: () => problems });
    sidebar.addContextSourceChip("problems", () => session);
    const chip = session.chips[0];
    if (!isDiagnosticsChip(chip)) throw new Error("expected a diagnostics chip");
    expect(chip.count).toBe(1);

    // Ten minutes pass; a build runs.
    problems = [problem(), problem({ line: 20 }), problem({ line: 30 })];

    const resolve = sidebar.contextChipPayloads(session.chips);
    const payload = resolve(chip);
    expect(payload).toEqual({ kind: "diagnostics", items: problems });
    // And the chip's own number is untouched — it is the label, not the truth.
    expect(chip.count).toBe(1);
  });

  it("scopes the re-read the way the chip was scoped", () => {
    const seen: HostDiagnosticsScope[] = [];
    const { sidebar, session } = makeSidebar({
      getDiagnostics: (scope) => { seen.push(scope); return [problem()]; },
    });
    session.chips = [
      { kind: "diagnostics", id: "d1", scope: "workspace", severity: "all", count: 1, hidden: false, relPath: "Problems in the workspace" },
      { kind: "diagnostics", id: "d2", scope: "file", path: "/repo/src/a.ts", severity: "all", count: 1, hidden: false, relPath: "Problems in a.ts" },
    ];
    sidebar.contextChipPayloads(session.chips);
    expect(seen).toEqual([
      { scope: "workspace", path: undefined },
      { scope: "file", path: "/repo/src/a.ts" },
    ]);
  });

  it("never touches a source for a HIDDEN chip", () => {
    const getDiagnostics = vi.fn(() => [problem()]);
    const { sidebar, session } = makeSidebar({ getDiagnostics });
    session.chips = [{
      kind: "diagnostics", id: "d1", scope: "workspace", severity: "all",
      count: 1, hidden: true, relPath: "Problems in the workspace",
    }];
    const resolve = sidebar.contextChipPayloads(session.chips);
    expect(getDiagnostics).not.toHaveBeenCalled();
    expect(resolve(session.chips[0])).toBeUndefined();
  });

  it("never probes anything for a plain file chip", () => {
    const getDiagnostics = vi.fn(() => [problem()]);
    const getTerminalCapture = vi.fn(() => ({ label: "bash", text: "x" }));
    const { sidebar, session } = makeSidebar({ getDiagnostics, getTerminalCapture });
    session.chips = [{ id: "explicit:/a.ts:0-0:1", path: "/a.ts", relPath: "a.ts", hidden: false }];
    sidebar.contextChipPayloads(session.chips);
    expect(getDiagnostics).not.toHaveBeenCalled();
    expect(getTerminalCapture).not.toHaveBeenCalled();
  });

  it("a source that throws at send costs its block, not the turn", () => {
    const { sidebar, session } = makeSidebar({
      getDiagnostics: () => { throw new Error("collection exploded"); },
    });
    session.chips = [{
      kind: "diagnostics", id: "d1", scope: "workspace", severity: "all",
      count: 3, hidden: false, relPath: "Problems in the workspace",
    }];
    let resolve!: (chip: ContextChip) => unknown;
    expect(() => { resolve = sidebar.contextChipPayloads(session.chips); }).not.toThrow();
    expect(resolve(session.chips[0])).toBeUndefined();
    expect(sidebar.host.appendLine).toHaveBeenCalledWith(
      expect.stringContaining("collection exploded"),
    );
  });

  it("a terminal whose capture vanished between attach and send resolves to nothing", () => {
    const { sidebar, session } = makeSidebar({ getTerminalCapture: () => undefined });
    session.chips = [{
      kind: "terminal", id: "t1", label: "bash", bytes: 40, hidden: false,
      relPath: "Terminal output (bash)",
    }];
    const resolve = sidebar.contextChipPayloads(session.chips);
    expect(resolve(session.chips[0])).toBeUndefined();
  });

  it("keys payloads by chip id, so two chips of one kind stay apart", () => {
    const { sidebar, session } = makeSidebar({
      getDiagnostics: (scope) => scope.scope === "workspace" ? [problem()] : [problem({ line: 99 })],
    });
    session.chips = [
      { kind: "diagnostics", id: "d1", scope: "workspace", severity: "all", count: 1, hidden: false, relPath: "Problems in the workspace" },
      { kind: "diagnostics", id: "d2", scope: "file", path: "/repo/src/a.ts", severity: "all", count: 1, hidden: false, relPath: "Problems in a.ts" },
    ];
    const resolve = sidebar.contextChipPayloads(session.chips);
    expect(resolve(session.chips[0])).toEqual({ kind: "diagnostics", items: [problem()] });
    expect(resolve(session.chips[1])).toEqual({ kind: "diagnostics", items: [problem({ line: 99 })] });
  });
});
