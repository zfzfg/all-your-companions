import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

// @vscode/test-electron smoke suite — the layer the grok-free vitest suite structurally
// can't reach: it boots a real VS Code, activates the extension, and resolves the webview
// inside a genuine Extension Host. Test-mode activate latches isolateFromInstalledGrok
// before any view can resolve, so the first suite stays on the *missing-CLI* onboarding
// path (activation, command registration, getHtml/CSP, localResourceRoots) even on a
// developer box with grok installed. The sessions suite then provisions
// test/fixtures/fake-grok-acp.cjs where a test needs an ACP CLI without a real
// grok binary.

// This fork's identity: package.json `publisher`.`name`. Upstream was
// PawelHuryn.grok-vscode-phuryn — a rename here is a rename in package.json.
const EXT_ID = "zfzfg.all-your-companions";

suite("grok-build extension smoke", () => {
  test("is present and activates without throwing", async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, `extension ${EXT_ID} not found — check publisher.name`);
    await ext!.activate();
    assert.ok(ext!.isActive, "extension failed to activate");
  });

  test("registers its contributed commands", async () => {
    const all = await vscode.commands.getCommands(true);
    // A stable subset that must always exist (the full list lives in package.json).
    for (const id of [
      "grok.open",
      "grok.newSession",
      "grok.runCrew",
      "grok.showLogs",
      "grok.settings",
      "grok.findInSession",
      "grok.logout",
      // The escape hatch for an editor that hid the view somewhere unreachable —
      // useless if it is not in the palette.
      "grok.moveView",
    ]) {
      assert.ok(all.includes(id), `command not registered: ${id}`);
    }
    // The gear-menu "Move view" items depend on these workbench commands
    // (vscode.moveViews is internal but stable — GitLens relies on it too).
    for (const id of ["vscode.moveViews", "workbench.action.moveFocusedView"]) {
      assert.ok(all.includes(id), `workbench command missing: ${id}`);
    }
  });

  test("grok.open actually opens the chat", async () => {
    // The regression this exists for: `grok.open` used to execute a hardcoded
    // container command, and in an editor that refuses our secondary-side-bar
    // container that command does not exist — so opening the chat failed with
    // "command not found" and the extension could not be used at all (#101
    // follow-up). This assertion is the whole test: it must REJECT nothing.
    //
    // It replaces a version that ran `grok.chat.focus`, swallowed any failure,
    // and then asserted `true` — which would have passed throughout the outage.
    await vscode.commands.executeCommand("grok.open");
  });

  test("resolving the webview view does not crash (missing-CLI onboarding path)", async () => {
    // Focusing the view triggers resolveWebviewView -> getHtml -> the first posts.
    // With no grok binary on the CI box the extension takes the missing-CLI onboarding
    // branch; reaching the assertion below without an unhandled rejection is the check.
    // VS Code derives `<viewId>.focus` from contributes.views; this fork's chat
// view is `companions.chat` (`grok.chat` remains only as a legacy provider
// registration, which contributes no focus command).
    await vscode.commands.executeCommand("companions.chat.focus");
    await new Promise((r) => setTimeout(r, 2000)); // let the webview resolve + post
    // A second, lightweight command that touches the sidebar without needing grok.
    await vscode.commands.executeCommand("grok.showLogs");
    assert.ok(true, "webview resolved without throwing");
  });

  // TODO (follow-up): inject a synthetic `session`/`historyReplay` event and assert the
  // webview renders it. The hook now exists (see the sessions suite below).
});

// The local host against a real Extension Host. These hooks prove what the
// unit suite cannot: the real host posts, persists and cleans up history in a
// genuine VS Code, with a hermetic GROK_HOME and a fake ACP CLI.
suite("sessions and history in the local host", () => {
  let hooks: any;
  let repoB = "";
  let grokHome = "";
  const prevGrokHome = process.env.GROK_HOME;

  const storedSessionDirFor = (cwd: string, id: string) =>
    path.join(grokHome, "sessions", encodeURIComponent(cwd), id);
  const storedSessionDir = (id: string) => storedSessionDirFor(repoB, id);

  const writeStoredSession = (id: string, cwd = repoB, updatedAt?: string) => {
    const dir = storedSessionDirFor(cwd, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "summary.json"),
      updatedAt ? JSON.stringify({ updated_at: updatedAt }) : "{}",
    );
  };

  // Hermetic ACP for the tests that actually resolve a CLI.
  const provisionFakeCli = () => {
    const fakeCli = process.platform === "win32"
      ? path.join(__dirname, "..", "test", "fixtures", "fake-grok-acp.cmd")
      : path.join(__dirname, "..", "test", "fixtures", "fake-grok-acp.sh");
    if (process.platform !== "win32") {
      try { fs.chmodSync(fakeCli, 0o755); } catch { /* best-effort */ }
    }
    assert.ok(fs.existsSync(fakeCli), `fake ACP CLI missing: ${fakeCli}`);
    return hooks.provisionFakeGrok(fakeCli);
  };

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXT_ID);
    assert.ok(ext, "extension not found");
    const api = await ext!.activate();
    hooks = api?.__test;
    assert.ok(hooks, "test hooks missing — activate() exposes them under ExtensionMode.Test");

    // A second project. `discoverRepos` enumerates <grokHome>/sessions/<encoded
    // cwd> and stats each decoded path, so the catalog needs BOTH a session dir and a
    // real directory. The sessions STORE is sandboxed through GROK_HOME
    // (`resolveGrokHome` reads process.env on every call, and this runs inside the
    // extension host), so nothing here touches the developer's own ~/.grok.
    //
    // The repo itself must NOT live under os.tmpdir(): discoverRepos rejects temp roots
    // on purpose, because grok's own `grok-live-*` test sessions pile up there. A
    // fixture in tmp is silently filtered and the test then proves nothing.
    grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-int-home-"));
    repoB = path.join(hooks.workspaceRoot(), ".int-second-repo");
    fs.mkdirSync(repoB, { recursive: true });
    fs.mkdirSync(path.join(repoB, ".git"), { recursive: true });
    fs.mkdirSync(path.join(grokHome, "sessions", encodeURIComponent(repoB)), { recursive: true });
    process.env.GROK_HOME = grokHome;
    // Test-mode activate already latches isolateFromInstalledGrok so the first
    // suite's webview focus cannot spawn an installed CLI. Repeat here so this
    // suite stays isolated even if that activate-time call is later removed.
    hooks.isolateFromInstalledGrok();
  });

  suiteTeardown(() => {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME;
    else process.env.GROK_HOME = prevGrokHome;
    hooks?.onPost(() => {});
    try {
      fs.rmSync(repoB, { recursive: true, force: true });
      fs.rmSync(grokHome, { recursive: true, force: true });
    } catch {
      /* best effort — it lives in the throwaway fixture workspace */
    }
  });

  test("isolateFromInstalledGrok keeps locateProvider off an installed CLI", async () => {
    const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-iso-decoy-"));
    const decoy = path.join(decoyDir, process.platform === "win32" ? "grok.cmd" : "grok");
    fs.writeFileSync(decoy, process.platform === "win32" ? "@echo off\r\nexit 1\r\n" : "#!/bin/sh\nexit 1\n");
    const cfg = vscode.workspace.getConfiguration("grok");
    const previous = cfg.inspect<string>("cliPath")?.globalValue;
    hooks.isolateFromInstalledGrok();
    try {
      await cfg.update("cliPath", decoy, vscode.ConfigurationTarget.Global);
      assert.strictEqual(
        hooks.locatedGrokCli(),
        undefined,
        "isolated discovery must ignore grok.cliPath and PATH",
      );
      const restore = provisionFakeCli();
      try {
        const located = hooks.locatedGrokCli();
        assert.ok(
          located && /fake-grok-acp/.test(located),
          `provisioned fake must still resolve: ${located}`,
        );
      } finally {
        restore();
      }
      assert.strictEqual(
        hooks.locatedGrokCli(),
        undefined,
        "restore after provision must stay isolated",
      );
    } finally {
      await cfg.update("cliPath", previous, vscode.ConfigurationTarget.Global);
      try { fs.rmSync(decoyDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  test("a failed cold replay still posts one balanced replay pair around what loaded", async () => {
    // session/load cannot be aborted, and a failure half-way must not leave the
    // webview inside a replay: it would keep suppressing live output for good.
    const id = `failed-cold-session-${Date.now()}`;
    hooks.seedFocusedSession(id, repoB, [], true);
    const posts: any[] = [];
    hooks.onPost((msg: any) => posts.push(msg));

    await assert.rejects(
      hooks.replayFocused([{ type: "messageChunk", text: "partial load" }], undefined, true),
      /synthetic session\/load failure/,
    );

    assert.deepStrictEqual(
      posts.filter((msg) => msg?.type === "historyReplay" || msg?.type === "messageChunk"),
      [
        { type: "historyReplay", active: true },
        { type: "messageChunk", text: "partial load" },
        { type: "historyReplay", active: false },
      ],
    );
  });

  test("context usage is read from the session's repo, not the VS Code workspace", () => {
    const id = `context-${Date.now()}`;
    const workspaceDir = storedSessionDirFor(hooks.workspaceRoot(), id);
    const sessionDir = storedSessionDirFor(repoB, id);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "signals.json"), JSON.stringify({
      contextTokensUsed: 111,
      contextWindowTokens: 100000,
    }));
    fs.writeFileSync(path.join(sessionDir, "signals.json"), JSON.stringify({
      contextTokensUsed: 222,
      contextWindowTokens: 200000,
    }));
    hooks.seedFocusedSession(id, repoB);
    const posts: any[] = [];
    hooks.onPost((msg: any) => posts.push(msg));

    hooks.emitContextUsage();

    assert.deepStrictEqual(
      posts.filter((msg) => msg?.type === "contextUsage"),
      [{ type: "contextUsage", used: 222, window: 200000 }],
    );
  });

  test("rewind keeps discarded usage out after another turn and a reload", async () => {
    const id = `usage-session-${Date.now()}`;
    hooks.seedFocusedSession(id, repoB, [], true);
    await hooks.seedUsageLedger([
      { afterUserMessage: 1, usage: { inputTokens: 100, outputTokens: 10, costUsdTicks: 10_000_000 } },
      { afterUserMessage: 2, usage: { inputTokens: 200, outputTokens: 20, costUsdTicks: 20_000_000 } },
      { afterUserMessage: 3, usage: { inputTokens: 300, outputTokens: 30, costUsdTicks: 30_000_000 } },
    ], 3);

    await hooks.rewindUsageLedger(1);
    await hooks.completeUsageTurn({
      inputTokens: 400,
      outputTokens: 40,
      costUsdTicks: 40_000_000,
    });
    const restored = hooks.reloadUsageLedger(2);

    assert.deepStrictEqual(
      restored.usageLog.map((entry: any) => ({
        afterUserMessage: entry.afterUserMessage,
        inputTokens: entry.usage?.inputTokens,
        costUsdTicks: entry.usage?.costUsdTicks,
      })),
      [
        { afterUserMessage: 1, inputTokens: 100, costUsdTicks: 10_000_000 },
        { afterUserMessage: 2, inputTokens: 400, costUsdTicks: 40_000_000 },
      ],
    );
    assert.deepStrictEqual(restored.sessionUsage, {
      inputTokens: 500,
      outputTokens: 50,
      costUsdTicks: 50_000_000,
    });
  });

  for (const mode of ["clear", "summarize"] as const) {
    test(`${mode} restart derives cost from the replacement session id`, async () => {
      const suffix = `${mode}-${Date.now()}`;
      const oldId = `usage-old-${suffix}`;
      const newId = `usage-new-${suffix}`;
      hooks.seedFocusedSession(oldId, repoB, [], true);
      await hooks.seedUsageLedger([{
        afterUserMessage: 1,
        usage: { inputTokens: 100, outputTokens: 10, costUsdTicks: 90_000_000 },
      }], 1);

      const summaryUsage = mode === "summarize"
        ? { inputTokens: 5, outputTokens: 2, costUsdTicks: 5_000_000 }
        : undefined;
      await hooks.restartUsageSession(newId, mode, summaryUsage);
      await hooks.completeUsageTurn({
        inputTokens: 40,
        outputTokens: 4,
        costUsdTicks: 40_000_000,
      });
      const restored = hooks.reloadUsageLedger(1);

      assert.deepStrictEqual(
        restored.usageLog.map((entry: any) => entry.usage?.costUsdTicks),
        mode === "summarize" ? [5_000_000, 40_000_000] : [40_000_000],
      );
      assert.strictEqual(
        restored.sessionUsage?.costUsdTicks,
        mode === "summarize" ? 45_000_000 : 40_000_000,
      );
    });
  }

  test("delete and Clear all preserve a conversation while it is cold-loading", async () => {
    const id = `cold-protected-${Date.now()}`;
    const clearableId = `cold-clearable-${Date.now()}`;
    writeStoredSession(id);
    writeStoredSession(clearableId);
    const delay = hooks.delayNextSessionStart(id);
    const localOpen = hooks.openLocalSession(id, repoB);
    await delay.started;

    try {
      await hooks.fromLocal({ type: "deleteSession", id, name: "Cold loading", cwd: repoB });
      assert.ok(fs.existsSync(storedSessionDir(id)), "delete must preserve the reserved session id");

      await hooks.fromLocal({ type: "clearAllSessions", cwd: repoB });
      assert.ok(fs.existsSync(storedSessionDir(id)), "Clear all must preserve the reserved session id");
      assert.ok(!fs.existsSync(storedSessionDir(clearableId)), "Clear all should still remove ownerless history");
    } finally {
      delay.release();
      await localOpen;
    }
  });

  test("the empty-session sweep removes what nothing was there to park, and only that", async () => {
    // #97. `parkFocused` handles the session you walk away from inside a running
    // window; nothing handled the ones nobody was there to park — a window closed
    // without a prompt, a host that crashed. The old sweep required our hidden
    // primer, so once that was retired it recognised nothing and the directories
    // collected as "Untitled" rows the CLI cannot even load.
    const stamp = Date.now();
    const bootOnly = [
      JSON.stringify({ type: "system", content: [{ type: "text", text: "You are Grok." }] }),
      JSON.stringify({
        type: "user",
        content: [{ type: "text", text: "<system-reminder>\navailable skills\n</system-reminder>" }],
        synthetic_reason: "system_reminder",
      }),
    ].join("\n");
    const realTurn = [
      bootOnly,
      JSON.stringify({ type: "user", content: [{ type: "text", text: "<user_query>\nfix the flaky test\n</user_query>" }] }),
    ].join("\n");
    // Backdated on purpose: the sweep only claims a session was ABANDONED, and
    // refuses to claim that about one grok registered moments ago (which may not
    // have written its history yet, or may belong to another window).
    const writeSession = (id: string, numMessages: number, history?: string) => {
      const dir = storedSessionDirFor(repoB, id);
      fs.mkdirSync(dir, { recursive: true });
      const summary = path.join(dir, "summary.json");
      fs.writeFileSync(
        summary,
        JSON.stringify({ info: { id, cwd: repoB }, num_messages: numMessages, session_summary: "" }),
      );
      if (history !== undefined) fs.writeFileSync(path.join(dir, "chat_history.jsonl"), history);
      const old = new Date(Date.now() - 60 * 60 * 1000);
      fs.utimesSync(summary, old, old);
    };

    const bare = `sweep-bare-${stamp}`;     // only summary.json — the unloadable shape
    const booted = `sweep-booted-${stamp}`; // grok's own boot lines, never typed into
    const real = `sweep-real-${stamp}`;     // one real user query
    const live = `sweep-live-${stamp}`;     // empty, but a live session owns it
    writeSession(bare, 0);
    writeSession(booted, 0, bootOnly);
    writeSession(real, 3, realTurn);
    writeSession(live, 0, bootOnly);
    hooks.seedLocalBackgroundSession(live, repoB);

    hooks.sweepEmptySessions(repoB);

    assert.ok(!fs.existsSync(storedSessionDirFor(repoB, bare)), "a directory holding only summary.json must go");
    assert.ok(!fs.existsSync(storedSessionDirFor(repoB, booted)), "a session never typed into must go");
    assert.ok(fs.existsSync(storedSessionDirFor(repoB, real)), "a session with a real turn must survive");
    assert.ok(
      fs.existsSync(storedSessionDirFor(repoB, live)),
      "a live session must survive — its CLI owns the directory and re-persists it",
    );

    // The same directory, freshly stamped, is not something the sweep will claim
    // to know about: parking removes those, and one window must not delete what
    // another just created.
    const recent = `sweep-recent-${stamp}`;
    writeSession(recent, 0, bootOnly);
    const now = new Date();
    fs.utimesSync(path.join(storedSessionDirFor(repoB, recent), "summary.json"), now, now);
    hooks.sweepEmptySessions(repoB);
    assert.ok(fs.existsSync(storedSessionDirFor(repoB, recent)), "a session created moments ago must survive");
    fs.rmSync(storedSessionDirFor(repoB, recent), { recursive: true, force: true });
  });

  test("local applyWorktree/removeWorktree with a stale sessionId are refused", async () => {
    const worktree = path.join(hooks.workspaceRoot(), ".int-stale-wt");
    const probe = hooks.seedFocusedWorktreeSession("focused-wt", {
      path: worktree,
      label: "Stale fixture",
      sourceGitRoot: hooks.workspaceRoot(),
    });
    const posts: any[] = [];
    hooks.onPost((msg: any) => posts.push(msg));

    await hooks.fromLocal({ type: "applyWorktree", sessionId: "not-the-focused-session" });
    await hooks.fromLocal({ type: "removeWorktree", sessionId: "not-the-focused-session" });

    const refusals = posts.filter((msg) =>
      msg?.type === "hostNotice" &&
      msg.text === "That conversation is no longer focused — nothing was changed."
    );
    assert.strictEqual(refusals.length, 2);
    assert.strictEqual(probe.applyCount(), 0);
    assert.strictEqual(probe.removeCount(), 0);
    probe.restore();
  });

  test("local applyWorktree/removeWorktree with a matching sessionId run on the focused session", async () => {
    hooks.isolateFromInstalledGrok();
    const worktree = path.join(hooks.workspaceRoot(), ".int-match-wt");
    const probe = hooks.seedFocusedWorktreeSession("focused-wt-match", {
      path: worktree,
      label: "Match fixture",
      sourceGitRoot: hooks.workspaceRoot(),
    });
    const posts: any[] = [];
    hooks.onPost((msg: any) => posts.push(msg));

    await hooks.fromLocal({ type: "applyWorktree", sessionId: "focused-wt-match" });
    await hooks.fromLocal({ type: "removeWorktree", sessionId: "focused-wt-match" });

    assert.ok(!posts.some((msg) =>
      msg?.type === "hostNotice" && /no longer focused/.test(msg.text)
    ));
    assert.strictEqual(probe.applyCount(), 1);
    assert.strictEqual(probe.lastApplyPath(), worktree);
    assert.strictEqual(probe.removeCount(), 1);
    assert.strictEqual(probe.lastRemovePath(), worktree);
    probe.restore();
  });
});

// ── VS Code host adapter: real URI encode / closeDiff / content provider ─────
// The unit suite cannot import vscode-host (needs the vscode module). These
// tests run under a real Extension Host and must fail if toVsCodeUri /
// fromVsCodeUri / closeDiffTabs are broken. `npm run test:integration` compiles
// the extension to out/ first, so we load the built adapter from there.
suite("VS Code host adapter URI surface", () => {
  type PortableUri = {
    scheme: string;
    authority: string;
    path: string;
    query: string;
    fragment: string;
    fsPath: string;
    toString(): string;
  };

  // Compiled extension output (CommonJS) — not recompiled by integration/tsconfig.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const hostMod = require("../out/vscode-host") as {
    createVsCodeHost: (output: vscode.OutputChannel) => {
      asRelativePath(uri: PortableUri): string;
      fs: {
        readFile(uri: PortableUri): Promise<Uint8Array>;
        writeFile(uri: PortableUri, content: Uint8Array): Promise<void>;
        createDirectory(uri: PortableUri): Promise<void>;
        stat(uri: PortableUri): Promise<{ type: number; ctime: number; mtime: number; size: number }>;
        delete(uri: PortableUri, options?: { recursive?: boolean; useTrash?: boolean }): Promise<void>;
      };
      openDiff(
        left: PortableUri,
        right: PortableUri,
        title: string,
        options?: { preview?: boolean; preserveFocus?: boolean },
      ): Thenable<void>;
      closeDiffTabs(original: PortableUri, modified: PortableUri): void;
      registerTextDocumentContentProvider(
        scheme: string,
        provider: { provideTextDocumentContent(uri: { path: string; toString(): string }): string },
      ): { dispose(): void };
    };
    createVsCodeHostContext: (context: vscode.ExtensionContext) => {
      extensionUri: PortableUri;
      globalStorageUri: PortableUri;
      extensionId: string;
    };
    wrapWebview: (webview: vscode.Webview) => {
      options: { enableScripts?: boolean; localResourceRoots?: PortableUri[] };
      asWebviewUri(uri: PortableUri): string;
    };
    toVsCodeUri: (u: PortableUri) => vscode.Uri;
    fromVsCodeUri: (u: vscode.Uri) => PortableUri;
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Uri } = require("../out/host") as {
    Uri: {
      from(components: {
        scheme: string;
        path: string;
        authority?: string;
        query?: string;
        fragment?: string;
        fsPath?: string;
      }): PortableUri;
      file(fsPath: string): PortableUri;
      joinPath(base: PortableUri, ...pathSegments: string[]): PortableUri;
    };
  };

  const { createVsCodeHost, createVsCodeHostContext, wrapWebview, toVsCodeUri, fromVsCodeUri } = hostMod;
  let output: vscode.OutputChannel;
  let host: ReturnType<typeof createVsCodeHost>;

  suiteSetup(() => {
    output = vscode.window.createOutputChannel("Grok adapter integration");
    host = createVsCodeHost(output);
  });

  suiteTeardown(() => {
    output?.dispose();
  });

  test("authority survives fromVsCodeUri → toVsCodeUri", () => {
    const remote = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+dev.example",
      path: "/home/me/proj/src/main.ts",
    });
    const portable = fromVsCodeUri(remote);
    assert.strictEqual(portable.scheme, "vscode-remote");
    assert.strictEqual(portable.authority, "ssh-remote+dev.example");
    assert.strictEqual(portable.path, "/home/me/proj/src/main.ts");
    assert.strictEqual(portable.fsPath, remote.fsPath);

    const back = toVsCodeUri(portable);
    assert.strictEqual(back.scheme, remote.scheme);
    assert.strictEqual(back.authority, remote.authority);
    assert.strictEqual(back.path, remote.path);
    assert.strictEqual(back.toString(), remote.toString());
  });

  test("query, fragment, and fsPath survive fromVsCodeUri → toVsCodeUri", () => {
    const remote = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+dev.example",
      path: "/home/me/proj/doc.md",
      query: "view=preview&x=1",
      fragment: "section-2",
    });
    const portable = fromVsCodeUri(remote);
    assert.strictEqual(portable.query, "view=preview&x=1");
    assert.strictEqual(portable.fragment, "section-2");
    assert.strictEqual(portable.fsPath, remote.fsPath, "must keep VS Code's real fsPath");

    const back = toVsCodeUri(portable);
    assert.strictEqual(back.query, remote.query);
    assert.strictEqual(back.fragment, remote.fragment);
    assert.strictEqual(back.path, remote.path);
    assert.strictEqual(back.authority, remote.authority);
    // Round-trip again: fsPath must still match the original VS Code value.
    const again = fromVsCodeUri(back);
    assert.strictEqual(again.fsPath, remote.fsPath);
    assert.strictEqual(again.query, remote.query);
    assert.strictEqual(again.fragment, remote.fragment);
  });

  test("content-provider key round-trip preserves path special characters", async () => {
    const scheme = `grok-int-cp-${Date.now()}`;
    const specialPath = "/0/before/my file#x%y?.ts";
    let seenPath = "";
    let seenToString = "";
    const reg = host.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent(uri) {
        seenPath = uri.path;
        seenToString = uri.toString();
        return "provider-body";
      },
    });
    try {
      const portable = Uri.from({ scheme, path: specialPath });
      const vsUri = toVsCodeUri(portable);
      // VS Code asks the provider via the real vscode.Uri; our adapter must
      // convert back with fromVsCodeUri so the path is decoded, not percent-form.
      const doc = await vscode.workspace.openTextDocument(vsUri);
      assert.strictEqual(doc.getText(), "provider-body");
      assert.strictEqual(seenPath, specialPath, `provider saw path ${JSON.stringify(seenPath)}`);
      // Portable toString and the provider's portable uri must agree on encoding.
      assert.strictEqual(seenToString, portable.toString());
      assert.strictEqual(vsUri.toString(), portable.toString());
    } finally {
      reg.dispose();
    }
  });

  test("closeDiffTabs matches tabs whose filenames contain space, #, %, ?", async () => {
    const scheme = `grok-int-diff-${Date.now()}`;
    const fileName = "my file#x%y?.ts";
    const reg = host.registerTextDocumentContentProvider(scheme, {
      provideTextDocumentContent() {
        return "diff-side";
      },
    });
    try {
      const left = Uri.from({ scheme, path: `/0/before/${fileName}` });
      const right = Uri.from({ scheme, path: `/0/after/${fileName}` });

      // Broken dual-encoder would open a tab whose VS Code string is percent-
      // encoded, then fail to close it when comparing against a bare portable
      // toString() that disagreed. Both sides must go through toVsCodeUri.
      await host.openDiff(left, right, "adapter special-char diff", {
        preview: true,
        preserveFocus: true,
      });
      await new Promise((r) => setTimeout(r, 300));

      const leftKey = toVsCodeUri(left).toString();
      const rightKey = toVsCodeUri(right).toString();
      const countMatching = () => {
        let n = 0;
        for (const group of vscode.window.tabGroups.all) {
          for (const tab of group.tabs) {
            const input = tab.input;
            if (
              input instanceof vscode.TabInputTextDiff &&
              input.original.toString() === leftKey &&
              input.modified.toString() === rightKey
            ) {
              n++;
            }
          }
        }
        return n;
      };

      assert.ok(
        countMatching() >= 1,
        `expected an open diff tab for keys ${leftKey} / ${rightKey}`,
      );

      host.closeDiffTabs(left, right);
      await new Promise((r) => setTimeout(r, 400));

      assert.strictEqual(
        countMatching(),
        0,
        "closeDiffTabs must close the special-character diff tab (same-encoder compare)",
      );
    } finally {
      reg.dispose();
    }
  });

  test("asRelativePath with a workspace Uri returns a relative path", () => {
    const folders = vscode.workspace.workspaceFolders;
    assert.ok(folders?.length, "integration fixture must open a workspace folder");
    const folder = folders![0]!;
    // Build a portable Uri from the real workspace folder URI (preserves scheme).
    const childVs = vscode.Uri.joinPath(folder.uri, "README.md");
    const portable = fromVsCodeUri(childVs);
    const rel = host.asRelativePath(portable);
    // Must not fall through to the absolute path.
    assert.ok(
      !path.isAbsolute(rel) || rel === "README.md" || rel.endsWith(`${path.sep}README.md`) || rel.endsWith("/README.md"),
      `asRelativePath should be relative, got ${JSON.stringify(rel)}`,
    );
    assert.ok(
      /README\.md$/i.test(rel.replace(/\\/g, "/")),
      `expected README.md in relative path, got ${JSON.stringify(rel)}`,
    );
    // Path-only form must still work for local file workspaces (this fixture is file://).
    if (folder.uri.scheme === "file") {
      const viaFile = host.asRelativePath(Uri.file(childVs.fsPath));
      assert.strictEqual(viaFile, rel);
    }
  });

  test("createVsCodeHostContext preserves Uri identity (not path strings)", async () => {
    // Build a shim ExtensionContext whose URIs are remote — proves the adapter
    // stores fromVsCodeUri results, not .fsPath. A flatten-to-path revert makes
    // extensionUri/globalStorageUri undefined (or non-Uri) and fails.
    const remoteExt = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+box",
      path: "/home/me/.vscode-server/extensions/pawelhuryn.grok-vscode-phuryn",
    });
    const remoteStorage = vscode.Uri.from({
      scheme: "vscode-remote",
      authority: "ssh-remote+box",
      path: "/home/me/.vscode-server/data/User/globalStorage/pawelhuryn.grok-vscode-phuryn",
    });
    const shim = {
      secrets: {
        get: async () => undefined,
        store: async () => {},
        delete: async () => {},
      },
      globalStorageUri: remoteStorage,
      extensionUri: remoteExt,
      extension: {
        id: "PawelHuryn.grok-vscode-phuryn",
        packageJSON: { version: "0.0.0-test" },
      },
      extensionMode: vscode.ExtensionMode.Test,
      globalState: {
        get: () => undefined,
        update: async () => {},
        keys: () => [],
      },
      subscriptions: [],
    } as unknown as vscode.ExtensionContext;

    const ctx = createVsCodeHostContext(shim);
    assert.strictEqual(ctx.extensionUri.scheme, "vscode-remote");
    assert.strictEqual(ctx.extensionUri.authority, "ssh-remote+box");
    assert.strictEqual(ctx.globalStorageUri.scheme, "vscode-remote");
    assert.strictEqual(ctx.globalStorageUri.authority, "ssh-remote+box");
    // Flattening would only keep .fsPath strings — those fields must not exist.
    assert.strictEqual(
      (ctx as { extensionPath?: unknown }).extensionPath,
      undefined,
      "extensionPath string field must not be restored (use extensionUri)",
    );
    assert.strictEqual(
      (ctx as { globalStoragePath?: unknown }).globalStoragePath,
      undefined,
      "globalStoragePath string field must not be restored (use globalStorageUri)",
    );
    // Round-trip through toVsCodeUri keeps remote identity for asWebviewUri/fs.
    const backExt = toVsCodeUri(ctx.extensionUri);
    assert.strictEqual(backExt.scheme, "vscode-remote");
    assert.strictEqual(backExt.authority, "ssh-remote+box");
    const media = Uri.joinPath(ctx.extensionUri, "media", "chat.css");
    assert.strictEqual(media.scheme, "vscode-remote");
    assert.strictEqual(media.authority, "ssh-remote+box");
    assert.ok(media.path.endsWith("/media/chat.css"), media.path);
  });

  test("localResourceRoots + asWebviewUri preserve non-file scheme via wrapWebview", () => {
    // Real webview panel — construct vscode-remote roots without a real remote.
    // Flattening to path + Uri.file would rewrite scheme to "file" on read-back.
    const panel = vscode.window.createWebviewPanel(
      "grokUriBoundaryTest",
      "URI boundary",
      vscode.ViewColumn.One,
      { enableScripts: true, localResourceRoots: [] },
    );
    try {
      const wv = wrapWebview(panel.webview);
      const remoteRoot = Uri.from({
        scheme: "vscode-remote",
        authority: "ssh-remote+box",
        path: "/home/me/.vscode-server/extensions/ext/media",
        fsPath: "/home/me/.vscode-server/extensions/ext/media",
      });
      const localRoot = Uri.file(path.join(path.dirname(path.dirname(__filename)), "media"));
      wv.options = {
        enableScripts: true,
        localResourceRoots: [remoteRoot, localRoot],
      };
      const roots = wv.options.localResourceRoots ?? [];
      const remote = roots.find((r) => r.scheme === "vscode-remote");
      assert.ok(
        remote,
        `remote root must survive options set/get; got ${JSON.stringify(roots.map((r) => r.scheme + "://" + r.authority))}`,
      );
      assert.strictEqual(remote!.authority, "ssh-remote+box");
      assert.ok(remote!.path.includes("/media"), remote!.path);

      // asWebviewUri must accept the portable remote Uri (toVsCodeUri path).
      // If the adapter does Uri.file(uri.fsPath), VS Code still returns a string
      // — but the *input* scheme is lost. We assert toVsCodeUri of the same Uri
      // keeps scheme, and that asWebviewUri does not throw on a remote Uri.
      const asset = Uri.joinPath(remoteRoot, "chat.css");
      assert.strictEqual(toVsCodeUri(asset).scheme, "vscode-remote");
      const src = wv.asWebviewUri(asset);
      assert.ok(typeof src === "string" && src.length > 0, "asWebviewUri must return a string");
      // A correct remote-preserving call yields a webview resource URI; a file
      // rewrite of a remote path often still produces a string, so the scheme
      // check on toVsCodeUri above is the hard gate. Also reject empty.
      assert.ok(!src.startsWith("file:"), `webview URI should not be raw file: ${src}`);
    } finally {
      panel.dispose();
    }
  });

  test("host.fs round-trip uses Uri (toVsCodeUri), not path strings", async () => {
    // Write under a temp file Uri via host.fs — proves HostFileSystem takes Uri
    // and the adapter reaches workspace.fs. A path-string signature would not
    // compile; a Uri.file-only adapter still works for file:// — so also assert
    // toVsCodeUri preserves a non-file scheme for the same call shape.
    const dir = path.join(require("os").tmpdir(), `grok-fs-uri-${Date.now()}`);
    const dirUri = Uri.file(dir);
    const fileUri = Uri.file(path.join(dir, "probe.txt"));
    try {
      await host.fs.createDirectory(dirUri);
      await host.fs.writeFile(fileUri, Buffer.from("uri-fs-probe", "utf8"));
      const bytes = await host.fs.readFile(fileUri);
      assert.strictEqual(Buffer.from(bytes).toString("utf8"), "uri-fs-probe");
      const st = await host.fs.stat(fileUri);
      assert.ok(st.size > 0);

      // Non-file scheme must survive the encoder the adapter uses for fs.
      const remoteStorage = Uri.from({
        scheme: "vscode-remote",
        authority: "ssh-remote+box",
        path: "/home/me/.vscode-server/data/User/globalStorage/ext/plan-reviews/x",
        fsPath: "/home/me/.vscode-server/data/User/globalStorage/ext/plan-reviews/x",
      });
      const vs = toVsCodeUri(remoteStorage);
      assert.strictEqual(vs.scheme, "vscode-remote", "host.fs must convert via toVsCodeUri, not Uri.file");
      assert.strictEqual(vs.authority, "ssh-remote+box");
    } finally {
      try {
        await host.fs.delete(dirUri, { recursive: true, useTrash: false });
      } catch {
        /* best-effort cleanup */
      }
    }
  });
});
