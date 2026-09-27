import { describe, expect, it, vi } from "vitest";
import {
  createImplicitContext,
  type ImplicitContextDeps,
} from "../src/implicit-context";
import { Session } from "../src/session";

describe("ImplicitContext", () => {
  function makeHarness() {
    const store = new Map<string, any>();
    const posted: any[] = [];
    let currentChips: any[] = [];
    const focusedSession = new Session();
    focusedSession.cwd = "/workspace";

    const deps: ImplicitContextDeps = {
      host: {
        getConfiguration: vi.fn(() => ({
          get: (key: string, def: any) => def,
        })),
        getActiveTextEditor: vi.fn(),
        onDidChangeActiveTextEditor: vi.fn(() => ({ dispose: vi.fn() })),
        onDidChangeActiveTextEditorSelection: vi.fn(() => ({ dispose: vi.fn() })),
        appendLine: vi.fn(),
        showInformationMessage: vi.fn(),
        showWarningMessage: vi.fn(),
        findFiles: vi.fn(async () => []),
        openWorkspaceTextFiles: vi.fn(() => []),
        getDiagnostics: vi.fn(() => []),
        getTerminalCapture: vi.fn(() => undefined),
        asRelativePath: vi.fn((u) => u.fsPath),
      } as any,
      state: {
        get: <T>(k: string, def?: T): T => (store.get(k) ?? def) as T,
        update: vi.fn(async (k: string, val: any) => { store.set(k, val); }),
      },
      sessionCwd: () => "/workspace",
      workspaceRoot: () => "/workspace",
      getFocused: () => focusedSession,
      getChips: () => currentChips,
      setChips: (chips) => { currentChips = chips; },
      postChips: vi.fn(),
      post: (msg) => posted.push(msg),
      notifyUser: vi.fn(),
      revealAndFocusComposer: vi.fn(),
      trackAttach: vi.fn(),
      pickFileFromComputer: vi.fn(async () => {}),
    };

    const implicitContext = createImplicitContext(deps);
    return { implicitContext, deps, store, posted, focusedSession, getChips: () => currentChips };
  }

  it("watches active editor changes and disposes previous watchers", () => {
    const { implicitContext, deps } = makeHarness();
    implicitContext.watchActiveEditor();
    expect(deps.host.onDidChangeActiveTextEditor).toHaveBeenCalled();
    expect(deps.host.onDidChangeActiveTextEditorSelection).toHaveBeenCalled();
    expect(implicitContext.editorWatcher).toBeDefined();

    implicitContext.dispose();
    expect(implicitContext.editorWatcher).toBeUndefined();
  });

  it("adds problems diagnostics chip when problems are reported", () => {
    const { implicitContext, deps, focusedSession } = makeHarness();
    (deps.host.getDiagnostics as any).mockReturnValue([
      { message: "type error", range: { start: { line: 0 } } },
    ]);

    implicitContext.addContextSourceChip("problems", () => focusedSession);

    expect(focusedSession.chips).toHaveLength(1);
    expect(focusedSession.chips[0].kind).toBe("diagnostics");
    expect(deps.postChips).toHaveBeenCalled();
  });

  it("notifies when no problems are reported", () => {
    const { implicitContext, deps, focusedSession } = makeHarness();
    (deps.host.getDiagnostics as any).mockReturnValue([]);

    implicitContext.addContextSourceChip("problems", () => focusedSession);

    expect(focusedSession.chips).toHaveLength(0);
    expect(deps.notifyUser).toHaveBeenCalledWith("info", expect.stringContaining("No problems"));
  });
});
