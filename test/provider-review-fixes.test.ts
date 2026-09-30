import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { sessionsDirFor, type SessionListEntry } from "../src/sessions";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const providerSessionSrc = fs.readFileSync(path.join(root, "src", "provider-session.ts"), "utf8");
const sidebar = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8").replace(/\r\n/g, "\n");
const sessionStartSrc = fs.readFileSync(path.join(root, "src", "session-start.ts"), "utf8").replace(/\r\n/g, "\n");
const providerSetupSrc = fs.readFileSync(path.join(root, "src", "provider-setup.ts"), "utf8").replace(/\r\n/g, "\n");
const sessionCatalogSrc = fs.readFileSync(path.join(root, "src", "session-catalog.ts"), "utf8").replace(/\r\n/g, "\n");
const turnEditSrc = fs.readFileSync(path.join(root, "src", "turn-edit.ts"), "utf8").replace(/\r\n/g, "\n");

function methodBody(signature: string): string {
  const bareSig = signature.replace(/private\s+/, "");
  const inCatalog = sessionCatalogSrc.includes(bareSig);
  const inTurnEdit = turnEditSrc.includes(bareSig);
  const source = inCatalog ? sessionCatalogSrc : (inTurnEdit ? turnEditSrc : sidebar);
  const target = inCatalog || inTurnEdit ? bareSig : signature;
  const start = source.indexOf(target);
  expect(start, `${signature} must exist`).toBeGreaterThan(-1);
  if (inCatalog || inTurnEdit) {
    const match = source.slice(start + target.length).search(/\n  (?:async\s+|private\s+|public\s+|[a-zA-Z0-9_]+\s*\()/);
    const next = match < 0 ? source.length : start + target.length + match;
    return source.slice(start, next);
  }
  const next = sidebar.indexOf("\n  private ", start + signature.length);
  return sidebar.slice(start, next < 0 ? sidebar.length : next);
}

describe("multi-provider review regressions", () => {

  it("builds pinned Codex rows from the adapter-backed cache", () => {
    const body = methodBody("private buildPinnedSessions(");
    expect(body).toContain("this.allAdapterCatalogs()");
    expect(body).toContain("this.scheduleAdapterHistoryRefresh");
    expect(body).toContain("findCachedAdapterSession(");
    expect(body).toContain("pinnedAt: overrides[id]?.pinnedAt");
  });

  it("uses one ordinary Grok page and the complete cached Codex catalog for combined history", () => {
    const body = methodBody("private buildSessionsList(");
    expect(body).toContain("{ offset: providerCursor.grokOffset, limit, query }");
    expect(body).toContain("providers.includes(\"codex\")");
    expect(body).toContain("providers.includes(\"claude\")");
    expect(body).not.toContain("slotOffsets");
    expect(body).not.toContain("lookAhead");
  });

  it("exact-sorts the loaded Grok window before combined-provider merging", () => {
    const grokHome = fs.mkdtempSync(path.join(os.tmpdir(), "grok-combined-order-"));
    const cwd = path.join(grokHome, "repo");
    const catalog = sessionsDirFor(grokHome, cwd);
    const previousHome = process.env.GROK_HOME;
    try {
      process.env.GROK_HOME = grokHome;
      for (const [id, mtime] of [["mtime-new", 2_000], ["mtime-old", 1_000]] as const) {
        const dir = path.join(catalog, id);
        fs.mkdirSync(dir, { recursive: true });
        const summary = path.join(dir, "summary.json");
        fs.writeFileSync(summary, "{}");
        fs.utimesSync(summary, mtime / 1_000, mtime / 1_000);
      }

      const instance = Object.create(GrokSidebar.prototype) as any;
      instance.authorizedSessionCwds = vi.fn(() => [cwd]);
      instance.sessionCwdsForRepo = vi.fn(() => [cwd]);
      instance.refreshWorktreeCache = vi.fn(async () => {});
      instance.state = { get: vi.fn(() => ({})) };
      instance.host = { appendLine: vi.fn() };
      instance.pool = new Set<Session>();
      instance.annotateWorktreeLabels = vi.fn();
      instance.dotForId = vi.fn(() => "none");
      instance.readEntriesCachedMulti = vi.fn((ids: string[]) => ids.map((id): SessionListEntry => ({
        id,
        cwd,
        displayName: id,
        rawSummary: id,
        updatedAt: id === "mtime-old" ? 200 : 100,
        createdAt: 1,
        numMessages: 1,
      })));

      const result = instance.buildGrokSessionsList(
        cwd,
        { offset: 0, limit: 2 },
        null,
      );

      expect(result.entries.map((entry: SessionListEntry) => entry.id)).toEqual(["mtime-old", "mtime-new"]);
      expect(result.nextOffset).toBe(2);
    } finally {
      if (previousHome === undefined) delete process.env.GROK_HOME;
      else process.env.GROK_HOME = previousHome;
      fs.rmSync(grokHome, { recursive: true, force: true });
    }
  });

  it("routes every sidebar Codex discovery through the class-owned locator", () => {
    const cli = fs.readFileSync(path.join(root, "src", "provider-cli.ts"), "utf8");
    expect(cli.match(/locateCodexCli\(/g)).toHaveLength(1);
    const startAt = sessionStartSrc.indexOf("public async startSessionBody(");
    expect(startAt, "public async startSessionBody( must exist").toBeGreaterThan(-1);
    const startEnd = sessionStartSrc.indexOf("\n  private ", startAt + 1);
    const start = sessionStartSrc.slice(startAt, startEnd < 0 ? sessionStartSrc.length : startEnd);
    expect(start).toContain("this.deps.providerOps.locateProvider(session.provider)");
    expect(start).not.toContain("locateCodexCli(");
    const owner = providerSetupSrc.slice(
      providerSetupSrc.indexOf("locateProvider(provider: AcpProvider):"),
      providerSetupSrc.indexOf("locatedProviders():"),
    );
    expect(owner).toContain("managedStorageRoot: this.context?.globalStorageUri?.fsPath");
    expect(owner).toContain("arch: process.arch");
  });

  it("observes Codex logout success before entering the synchronous logout reset", () => {
    const body = providerSessionSrc.slice(providerSessionSrc.indexOf("async logout("), providerSessionSrc.indexOf("public finishProviderLogout("));
    const exec = body.indexOf("await execGrokCli(cliPath, logoutArgs");
    // Matched without its argument list: the invariant is the ORDER — the CLI is
    // observed to succeed before the reset — not the call's exact shape. Pinning
    // the full literal broke when a `report` callback was threaded through so a
    // cloud environment's failures reach the person who asked, which changed
    // nothing about the ordering this guards.
    const disconnect = body.indexOf("await this.finishProviderLogout(provider");
    expect(exec).toBeGreaterThan(-1);
    expect(disconnect).toBeGreaterThan(exec);
    expect(body.slice(exec, disconnect)).toContain("catch (error)");
    expect(body).toContain("The account remains connected");
    expect(body).toContain("this.deps.sidebarOps.locateProvider(provider)");
    expect(body).toContain('this.deps.sidebarOps.locateProvider("grok")');
    expect(body).toContain("await this.finishProviderLogout(provider");
    expect(body).toContain('await this.finishProviderLogout("grok"');
  });

  it("posts provider-specific recovery UI after a second auth failure", () => {
    const body = methodBody("private async recoverAuthAndResend(");
    // Via onboardingForSession, which still resolves to providerLoginState for
    // this case — the provider IS connected, its credentials just died — and
    // falls back to the three-way chooser only when nothing is connected at
    // all, where naming one agent's login would name one nobody picked.
    expect(body).toContain("this.onboardingForSession(session)");
  });

  it("routes Re-check through the provider credential probe without allowing Codex warm-up failure to escape", () => {
    const warmStart = providerSetupSrc.indexOf("async warmConnectedCodexModels(");
    expect(warmStart).toBeGreaterThan(-1);
    const warmEnd = providerSetupSrc.indexOf("\n  async warmConnectedClaudeModels(", warmStart);
    const warm = providerSetupSrc.slice(warmStart, warmEnd > 0 ? warmEnd : undefined);
    expect(warm).toContain("await warmCodexModelCache(");
    expect(warm).toContain("model-cache warm-up failed");
    const reprobeStart = providerSetupSrc.indexOf("async reprobeProviderCredentials(");
    expect(reprobeStart).toBeGreaterThan(-1);
    const reprobeEnd = providerSetupSrc.indexOf("\n  private providerCredentialFilePresent(", reprobeStart);
    const reprobe = providerSetupSrc.slice(reprobeStart, reprobeEnd > 0 ? reprobeEnd : undefined);
    expect(reprobe).toContain("PROVIDER_CLI[provider].credentialProbe");
    expect(reprobe).toContain("return this[probe](requireProof)");
    const cli = fs.readFileSync(path.join(root, "src", "provider-cli.ts"), "utf8");
    expect(cli).toContain('credentialProbe: "warmConnectedCodexModels"');
    const inboundSrc = fs.readFileSync(path.join(root, "src", "sidebar-inbound.ts"), "utf8").replace(/\r\n/g, "\n");
    const recheck = inboundSrc.slice(inboundSrc.indexOf('case "recheckConnection":'), inboundSrc.indexOf('case "logout":'));
    expect(recheck).toContain("await this.deps.providers.reprobeProviderCredentials(provider)");
  });

  it("refuses to clear adapter history that could not be refreshed", () => {
    const body = methodBody("private async clearAllSessions(");
    expect(body).toContain("const adapterHistoryChecked = new Set<AcpProvider>()");
    expect(body).toContain("adapterHistoryChecked.add(provider)");
    expect(body).toContain("adapterEntriesEligibleForClear(");
    const catchIdx = body.indexOf("history could not be checked, so its conversations were not cleared");
    const addIdx = body.indexOf("adapterHistoryChecked.add(provider)");
    const eligibleIdx = body.indexOf("adapterEntriesEligibleForClear(");
    const skipIdx = body.indexOf("if (!adapterHistoryChecked.has(provider)) continue");
    expect(catchIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(-1);
    expect(eligibleIdx).toBeGreaterThan(catchIdx);
    expect(skipIdx).toBeGreaterThan(eligibleIdx);
  });

  it("tears down ownerless live sessions before deleting their directories", () => {
    // Same lesson as deleteSession: a grok process holding the dir makes the
    // Windows delete fail, and the row comes back as a live-empty "New session".
    const body = methodBody("private async clearAllSessions(");
    const dispose = body.indexOf("this.disposeSession(s)");
    const clear = body.indexOf("clearSessions({");
    expect(dispose).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(dispose);
    expect(body).toContain("if (this.sessionHasLiveOwner(s)) continue");
    expect(body).toContain("this.sendLocalRepoSessionsPreview(cwd)");
  });

  it("never sweeps past the newest-N window, however tempting the old shells look", () => {
    const body = methodBody("private sweepEmptySessions(");
    // The scan stays bounded. Walking every `hasTranscript === false` entry
    // would reach shells that fell off the window — but that flag is a
    // SNAPSHOT, and another editor window can start a session's first prompt
    // after it was taken. The age gate does not save it either: an old session
    // that stayed open still looks stale, so an in-progress first write could
    // be deleted from a second window, unrecoverably. Historical shells are
    // inert; a lost conversation is not. Creation is stopped at the probe
    // instead (see the scratch cwd), which needs no such gamble.
    expect(body).toContain("GrokSidebar.SWEEP_SCAN_LIMIT");
    expect(body).not.toContain("entry.hasTranscript !== false");
  });

  it("freezes adapter listing time on first discovery for Codex and Claude", () => {
    const body = methodBody("private async refreshAdapterHistory(");
    expect(body).toContain("if (typeof previous.activeAt === \"number\") continue");
    expect(body).toContain("activeAt: adapterListEntry(entry, {}, provider, Date.now()).updatedAt");
    // No provider carve-out — Claude restamps on load, same pin Codex already had.
    expect(body).not.toContain('if (provider === "codex")');
    expect(body).not.toContain("...(provider === \"codex\"");
  });

  it("routes an empty provider pick through the cross-backend restart", async () => {
    const instance = Object.create(GrokSidebar.prototype) as any;
    const session = new Session();
    session.provider = "grok";
    session.activeSessionId = "empty-grok";
    session.client = { setModel: vi.fn(), dispose: vi.fn(async () => {}) } as any;
    const oldClient = session.client;
    instance.connectedProviders = vi.fn(() => ["grok", "codex"]);
    instance.sessionCwd = vi.fn(() => "/repo");
    instance.rememberProjectProvider = vi.fn(async () => {});
    instance.startSession = vi.fn(async () => {});
    instance.discardRestartedEmptySession = vi.fn();

    await instance.switchModel("gpt-5.6-sol", session, "codex");

    expect(session.provider).toBe("codex");
    expect(instance.rememberProjectProvider).toHaveBeenCalledWith("/repo", "codex", "gpt-5.6-sol");
    expect(instance.startSession).toHaveBeenCalledWith(undefined, session);
    expect(instance.discardRestartedEmptySession).toHaveBeenCalledWith("empty-grok", session);
    expect(oldClient!.setModel).not.toHaveBeenCalled();
  });

  it("infers an old client's cross-provider model and returns a targeted backstop", async () => {
    const instance = Object.create(GrokSidebar.prototype) as any;
    instance.state = {
      get: vi.fn(() => ({
        grok: { models: [{ modelId: "grok-build" }], seenAt: 1 },
        codex: { models: [{ modelId: "gpt-5.6-sol" }], seenAt: 1 },
      })),
    };
    const inferred = instance.providerForRequestedModel("grok-build", "codex");
    expect(inferred).toBe("grok");

    const session = new Session();
    session.provider = "codex";
    session.hasHistory = true;
    session.client = { setModel: vi.fn(async () => { throw new Error("Invalid params (-32602)"); }) } as any;
    instance.notifyUser = vi.fn();

    await instance.switchModel("grok-build", session, inferred);

    expect(session.client!.setModel).not.toHaveBeenCalled();
    expect(instance.notifyUser).toHaveBeenCalledWith(
      "warning",
      "This Codex conversation can only use Codex models. Start a new conversation to switch to Grok.",
    );
    const inboundForModel = fs.readFileSync(path.join(root, "src", "sidebar-inbound.ts"), "utf8");
    expect(inboundForModel.slice(inboundForModel.indexOf('case "setModel":'), inboundForModel.indexOf('case "installCodex":')))
      .toContain("providerForRequestedModel");
  });
});

describe("deleting a conversation the provider refuses", () => {

  it("removes the row even when the provider refuses the delete", () => {
    // Codex deletes with one `threadArchive(threadId)` and Claude removes a
    // session file; BOTH throw when the thread was never written, which is
    // every conversation nobody has used yet. The error was the visible half.
    // The damaging half was the `return` after it: the host abandoned its own
    // cleanup, so a failed delete left a row that could never be sent to.
    const body = methodBody("async deleteSession(");
    const call = body.indexOf("client.deleteSession(id)");
    const cleanup = body.indexOf("if (live) void this.disposeSession(live);");
    expect(call).toBeGreaterThan(-1);
    expect(cleanup).toBeGreaterThan(call);
    // No early exit between the provider call and our cleanup.
    expect(body.slice(call, cleanup)).not.toContain("return;");
  });

  it("does not tell the person their own system failed", () => {
    // The overwhelmingly common cause is a thread that was never there, so
    // the refusal is not news — it is the delete succeeding by another name.
    // A genuine provider failure returns the row on the next listing refresh,
    // which is visible and recoverable; neither outcome loses written work.
    const body = methodBody("async deleteSession(");
    const at = body.indexOf("could not delete");
    expect(at).toBeGreaterThan(-1);
    const adapterHalf = body.slice(0, body.indexOf("deleteSessionDir("));
    expect(adapterHalf).not.toContain("refused to delete this conversation");
    expect(adapterHalf).not.toContain("showErrorMessage");
  });

  it("stopped predicting whether the provider has a thread", () => {
    // Three attempts guessed and each was wrong in a different direction:
    // `hasHistory` (a suppressed Summarize & Restart turn writes a thread the
    // row calls empty), a flag set at the prompt call site (a prompt that
    // THREW still looked written), and one set from provider output (the user
    // turn persists before any agent output arrives). Guessing wrong one way
    // orphans a real thread; the other way is the original bug. The host
    // cannot see the moment a provider persists, so it no longer tries.
    expect(sidebar).not.toContain("providerWrote");
    expect(sidebar).not.toContain("providerPrompted");
  });

  it("a refused resume changes the words, never the behaviour", () => {
    // The pinned Claude adapter raises -32002 for two unrelated causes:
    //   "Query closed before response received"  (a query that died mid-resume)
    //   "No conversation found with session ID"  (missing or message-less)
    // The first happens to conversations holding real work. An earlier version
    // read this code as "empty" and started a fresh session on it, which opens
    // a blank transcript and tells the person their conversation never held
    // anything — while it sits on disk. Reverted; this pins the reason.
    const at = sessionStartSrc.indexOf("isResumeNotFound(err)");
    expect(at).toBeGreaterThan(-1);
    // Bounded to THIS branch: the next one legitimately quotes the adapter,
    // which is correct for a failure we cannot describe better.
    const branch = sessionStartSrc.slice(at, sessionStartSrc.indexOf("} else {", at));
    expect(branch).not.toContain("newSession(");
    expect(branch).not.toContain("activeSessionId =");
    expect(branch).not.toContain("hasHistory =");
    // And it must not quote the adapter or the id at the person.
    expect(branch).not.toContain("${msg}");
  });

});
