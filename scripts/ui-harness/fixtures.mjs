// Scenarios for the fork's UI surfaces. Each one is the host frames sidebar.ts
// posts for that state, in the order it posts them — the payload shapes are the
// ones src/protocol.ts declares and the DOM tests already drive.
//
// A chat scenario is `{ surface: "chat", run: async ({ send, page }) => … }`.
// A settings scenario is `{ surface: "settings", category, snapshot, run? }`.

// ---------------------------------------------------------------- helpers --

const turn = async (send, user, reply) => {
  await send({ type: "userMessage", text: user });
  await send({ type: "agentStart" });
  await send({ type: "messageChunk", text: reply });
  await send({ type: "promptComplete", meta: { totalTokens: 1200 } });
  await send({ type: "agentEnd", status: "completed", durationMs: 14_200 });
};

const reviewFile = (path, added, removed, over = {}) => ({
  path,
  added,
  removed,
  turnAdded: added,
  turnRemoved: removed,
  completed: true,
  turnCompleted: true,
  diff: { toolCallId: "t-" + path, oldText: "a", newText: "b", sites: [{ oldText: "a", newText: "b" }] },
  turnDiff: { toolCallId: "t-" + path, oldText: "a", newText: "b", sites: [{ oldText: "a", newText: "b" }] },
  ...over,
});

const workflowView = (over = {}) => ({
  runId: "run-1",
  idea: "Add CSV export to the report page",
  workflowName: "idea-to-done",
  workflowTitle: "Idea to done",
  status: "at-gate",
  subtitle: "Crew · paused before Implement (2/4)",
  stages: [
    { id: "plan", title: "Plan", status: "done", ordinal: 1 },
    { id: "implement", title: "Implement", status: "pending", ordinal: 2 },
    { id: "review", title: "Review", status: "pending", ordinal: 3 },
    { id: "fix", title: "Fix", status: "pending", ordinal: 4 },
  ],
  currentStageId: "implement",
  ...over,
});

const ELIGIBLE = [
  { provider: "claude", displayName: "Claude", defaultModel: "claude-opus-5", models: ["claude-opus-5", "claude-sonnet-5"] },
  { provider: "codex", displayName: "Codex", defaultModel: "gpt-5.5" },
];

const companion = (over = {}) => ({
  type: "companionSubagent",
  subagentId: "sa_1",
  label: "Auth inspector",
  provider: "gemini",
  providerName: "Google Antigravity",
  model: "gemini-3-flash",
  effort: "low",
  profile: "read-only",
  profileLabel: "read-only",
  status: "running",
  startedAt: Date.now() - 12_000,
  modelVerified: true,
  sameProviderAsParent: false,
  ...over,
});

// ------------------------------------------------------------ chat scenes --

export const CHAT_SCENARIOS = {
  "session-type-picker": {
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "agent", locked: false });
    },
  },
  "session-type-locked-crew": {
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: true });
    },
  },
  "crew-empty": {
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: false });
      await send({
        type: "workflowList",
        workflows: [
          { name: "idea-to-done", title: "Idea to done", whenToUse: "A feature or bug described in a sentence.", source: "builtin" },
          { name: "review-only", title: "Review only", whenToUse: "A second pair of eyes on work that is already done.", source: "project" },
          { name: "spike", title: "Research spike", whenToUse: "Answer a question before anybody writes code.", source: "global" },
        ],
        defaultWorkflow: "idea-to-done",
      });
    },
  },
  "crew-empty-no-workflows": {
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: false });
      await send({ type: "workflowList", workflows: [], defaultWorkflow: "idea-to-done" });
    },
  },
  "crew-run-legacy": {
    run: async ({ send }) => {
      await turn(send, "/crew default Ship the CSV export", "Starting a crew run.");
      await send({
        type: "crewRun",
        run: {
          runId: "run-1", goal: "Ship the CSV export", cwd: "/repo", status: "running", preset: "default",
          steps: [
            { index: 1, title: "Plan the export", role: "planner", status: "done", filesReported: [], filesObserved: [], durationMs: 41_000 },
            { index: 2, title: "Write the exporter", role: "implementer", status: "done", filesReported: ["src/export.ts"], filesObserved: ["src/export.ts", "src/util.ts"], durationMs: 128_000 },
            { index: 3, title: "Review the exporter", role: "reviewer", status: "running", filesReported: [], filesObserved: [] },
            { index: 4, title: "Fix review findings", role: "fixer", status: "pending", filesReported: [], filesObserved: [] },
          ],
        },
      });
    },
  },
  "workflow-running": {
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: true });
      await send({
        type: "workflowRun",
        run: workflowView({
          status: "running",
          subtitle: "Crew · Implement running (2/4)",
          stages: [
            { id: "plan", title: "Plan", status: "done", ordinal: 1 },
            { id: "implement", title: "Implement", status: "running", ordinal: 2 },
            { id: "review", title: "Review", status: "pending", ordinal: 3 },
            { id: "fix", title: "Fix", status: "pending", ordinal: 4 },
          ],
        }),
      });
    },
  },
  "workflow-gate": {
    height: 1150,
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: true });
      await send({
        type: "workflowRun",
        run: workflowView({
          gate: {
            kind: "normal",
            title: "Stage 1 of ~4 done: Plan",
            reason: "Next stage: Implement",
            summary: "A four-step plan: add an export button, a CSV serializer, a download route and tests.",
            filesObserved: [],
            proposedNext: [{ id: "implement", title: "Implement" }, { id: "review", title: "Review" }],
            nextStageId: "implement",
            eligible: ELIGIBLE,
            ineligible: [{ provider: "grok", message: "Grok is not logged in." }],
            preselected: "claude",
          },
        }),
      });
    },
  },
  "workflow-gate-0": {
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: true });
      await send({
        type: "workflowRun",
        run: workflowView({
          status: "at-gate",
          subtitle: "Crew · ready to start",
          stages: workflowView().stages.map((s) => ({ ...s, status: "pending" })),
          currentStageId: "plan",
          gate: {
            kind: "gate-0",
            title: "Next stage: Plan",
            reason: "Nothing has run yet. The planner reads the idea and writes a step list.",
            proposedNext: [{ id: "plan", title: "Plan" }],
            nextStageId: "plan",
            eligible: ELIGIBLE,
            ineligible: [],
          },
        }),
      });
    },
  },
  "workflow-gate-review": {
    height: 1150,
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: true });
      await send({
        type: "workflowRun",
        run: workflowView({
          subtitle: "Crew · paused before Fix (4/4)",
          stages: [
            { id: "plan", title: "Plan", status: "done", ordinal: 1 },
            { id: "implement", title: "Implement", status: "done", ordinal: 2 },
            { id: "review", title: "Review", status: "done", ordinal: 3 },
            { id: "fix", title: "Fix", status: "pending", ordinal: 4 },
          ],
          currentStageId: "fix",
          gate: {
            kind: "normal",
            title: "Stage 3 of ~4 done: Review",
            reason: "Review requests changes.",
            summary: "The serializer does not quote fields containing commas.",
            filesObserved: ["src/export.ts", "src/util.ts", "test/export.test.ts"],
            unreported: ["src/util.ts"],
            claimedOnly: ["docs/export.md"],
            verify: { command: "npm test", exitCode: 1, outputTail: "FAIL test/export.test.ts > quotes commas\n  expected '\"a,b\"' got 'a,b'\nTests: 1 failed, 41 passed" },
            verdict: "changes-requested",
            findings: [
              { id: "f1", severity: "high", file: "src/export.ts", line: 42, text: "Fields containing commas are not quoted." },
              { id: "f2", severity: "low", file: "src/util.ts", line: 7, text: "Unused import." },
            ],
            openQuestions: ["Should empty cells be exported as \"\" or nothing?"],
            proposedNext: [{ id: "fix", title: "Fix" }],
            nextStageId: "fix",
            eligible: ELIGIBLE,
            ineligible: [],
          },
        }),
      });
    },
  },
  "workflow-gate-stale": {
    height: 1150,
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: true });
      await send({
        type: "workflowRun",
        run: workflowView({
          gate: {
            kind: "stale",
            title: "Stage 1 of ~4 done: Plan",
            reason: "The workspace changed since this run paused.",
            staleDetails: ["HEAD moved from a1b2c3d to e4f5a6b.", "3 files changed outside the run."],
            proposedNext: [{ id: "implement", title: "Implement" }],
            nextStageId: "implement",
            eligible: ELIGIBLE,
            ineligible: [],
          },
        }),
      });
    },
  },
  "workflow-gate-fixer-limit": {
    run: async ({ send }) => {
      await send({ type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: true });
      await send({
        type: "workflowRun",
        run: workflowView({
          gate: {
            kind: "fixer-limit",
            title: "Stage 5 of ~4 done: Review",
            reason: "Review still requests changes after 2 fix rounds.",
            proposedNext: [{ id: "$pause", title: "Paused" }, { id: "$done", title: "Done" }, { id: "$cancel", title: "Cancel" }],
            eligible: [],
            ineligible: [],
          },
        }),
      });
    },
  },
  "todo-rail": {
    run: async ({ send }) => {
      await turn(send, "Add CSV export", "Working on it.");
      await send({
        type: "planEntries",
        entries: [
          { id: "1", content: "Read the report page component", status: "completed", priority: "medium" },
          { id: "2", content: "Add a CSV serializer with quoting", status: "in_progress", priority: "high" },
          { id: "3", content: "Wire the Export button", status: "pending", priority: "medium" },
          { id: "4", content: "Write tests for commas and newlines", status: "pending", priority: "low" },
        ],
      });
    },
  },
  "review-center": {
    run: async ({ send }) => {
      await turn(send, "Add CSV export", "Done — three files changed.");
      await send({
        type: "reviewCenter",
        currentTurnId: "turn-1",
        files: [
          reviewFile("src/export.ts", 84, 3),
          reviewFile("src/components/ReportPage.tsx", 12, 2),
          reviewFile("test/export.test.ts", 41, 0),
        ],
      });
    },
  },
  "review-center-empty-turn": {
    run: async ({ send }) => {
      await turn(send, "Explain the export", "It serializes rows.");
      await send({
        type: "reviewCenter",
        currentTurnId: "turn-2",
        files: [reviewFile("src/export.ts", 84, 3, { turnAdded: 0, turnRemoved: 0, turnCompleted: false, turnDiff: undefined })],
      });
    },
  },
  "rails-stacked": {
    run: async ({ send }) => {
      await turn(send, "Add CSV export", "Working on it.");
      await send({
        type: "planEntries",
        entries: [
          { id: "1", content: "Read the report page", status: "completed" },
          { id: "2", content: "Add a serializer", status: "in_progress" },
          { id: "3", content: "Wire the button", status: "pending" },
        ],
      });
      await send({ type: "subagentTray", subagents: [
        { subagentId: "sa_1", label: "Auth inspector", provider: "gemini", providerName: "Google Antigravity", model: "gemini-3-flash", startedAt: Date.now() - 25_000 },
        { subagentId: "sa_2", label: "Test mapper", provider: "codex", providerName: "Codex", startedAt: Date.now() - 4_000 },
      ] });
      await send({
        type: "reviewCenter",
        currentTurnId: "turn-1",
        files: [reviewFile("src/export.ts", 84, 3), reviewFile("test/export.test.ts", 41, 0)],
      });
    },
  },
  "turn-footer-second-opinion": {
    run: async ({ send }) => {
      await turn(send, "Add CSV export", "Done — the exporter is in `src/export.ts`.");
      await send({ type: "reviewCenter", currentTurnId: "turn-1", files: [reviewFile("src/export.ts", 84, 3)] });
    },
  },
  "limit-offer": {
    run: async ({ send }) => {
      await send({ type: "userMessage", text: "Refactor the exporter" });
      await send({ type: "agentStart" });
      await send({
        type: "limitOffer", id: "lim-1", kind: "quota", source: "grok",
        targets: [{ id: "claude", name: "Claude" }, { id: "codex", name: "Codex" }],
        title: "Grok's usage limit is reached",
        text: "Your Grok plan has no quota left until 18:00. You can continue this task with another companion — it gets a briefing, not the transcript.",
        recommended: "continue", status: "failed", durationMs: 3_000,
      });
    },
  },
  "limit-offer-resolved": {
    run: async ({ send }) => {
      await send({ type: "userMessage", text: "Refactor the exporter" });
      await send({ type: "agentStart" });
      await send({
        type: "limitOffer", id: "lim-1", kind: "rate", source: "grok",
        targets: [{ id: "claude", name: "Claude" }],
        title: "Grok is rate limited", text: "Too many requests. Try again in a minute.",
        recommended: "retry", status: "failed",
      });
      await send({ type: "limitOfferResolved", id: "lim-1", action: "continue", target: "claude", targetName: "Claude" });
    },
  },
  "agent-result": {
    height: 1150,
    run: async ({ send }) => {
      await send({ type: "userMessage", text: "/agent reviewer check the export" });
      await send({
        type: "agentResult", id: "run-1-1", runId: "run-1", step: 1, role: "reviewer",
        provider: "claude", providerName: "Claude", model: "claude-opus-5", effort: "high", mode: "plan",
        cost: "$1.23 · 4,210 tokens", durationMs: 42_000, outcome: "completed",
        summary: "Checked the diff against the briefing. The serializer is correct except for quoting.",
        files: ["src/export.ts", "src/util.ts"], open: ["the CRLF case"], failed: [],
        unreported: ["src/util.ts"], claimedOnly: ["docs/export.md"],
        origin: "command", sessionId: "role-session-1", cwd: "/repo",
      });
      await send({
        type: "agentResult", id: "run-2-1", runId: "run-2", step: 1, role: "implementer",
        provider: "codex", providerName: "Codex", model: "gpt-5.5",
        cost: "no cost reported", durationMs: 8_000, outcome: "failed",
        summary: "", files: [], open: [], failed: ["Could not start: Codex is not logged in."],
        origin: "handoff", detail: "Handed off from this session's review panel.",
      });
      await send({
        type: "agentResult", id: "run-3-1", runId: "run-3", step: 1, role: "reviewer",
        provider: "claude", providerName: "Claude", model: "claude-opus-5",
        cost: "$0.18", durationMs: 5_000, outcome: "cancelled",
        summary: "", files: [], open: [], failed: [], origin: "second-opinion",
        caution: "Only one companion is connected, so this was not an outside opinion.",
      });
    },
  },
  "companion-subagents": {
    height: 1150,
    run: async ({ send }) => {
      await send({ type: "userMessage", text: "Map every caller of verifyToken" });
      await send({ type: "agentStart" });
      await send(companion({ subagentId: "sa_0", label: "Schema checker", status: "pending-approval", provider: "codex", providerName: "Codex", model: "gpt-5.5", profile: "scoped-edit", profileLabel: "scoped edit" }));
      await send(companion());
      await send(companion({
        subagentId: "sa_2", label: "Test mapper", provider: "claude", providerName: "Claude", model: "claude-sonnet-5",
        status: "completed", startedAt: 1_000, endedAt: 22_000, summary: "17 call sites across 6 files; 2 bypass the middleware.",
        filesReported: ["src/auth.ts"], filesObserved: ["src/auth.ts", "src/session.ts"], unreported: ["src/session.ts"],
        effortClamped: { requested: "high", applied: "medium" }, promotable: true, sessionId: "child-2", startedBy: "agent",
      }));
      await send(companion({
        subagentId: "sa_3", label: "Lint pass", provider: "grok", providerName: "Grok", model: "grok-4.6",
        status: "failed", startedAt: 1_000, endedAt: 4_000, errorCode: "provider-unavailable", sameProviderAsParent: true, modelVerified: false,
      }));
      await send({ type: "subagentTray", subagents: [
        { subagentId: "sa_1", label: "Auth inspector", provider: "gemini", providerName: "Google Antigravity", model: "gemini-3-flash", startedAt: Date.now() - 12_000 },
      ] });
    },
  },
  "permission-rule-suggestions": {
    run: async ({ send }) => {
      await send({ type: "userMessage", text: "Run the tests" });
      await send({ type: "agentStart" });
      await send({
        type: "permissionRequest",
        req: {
          id: 12,
          toolCall: { toolCallId: "t", kind: "execute", title: "npm test -- --watch=false" },
          options: [
            { optionId: "once", name: "Allow once", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        },
        ruleSuggestions: [
          { id: "cmd-two", label: "npm test", match: { kind: "execute", commandPrefix: "npm test" }, scope: "workspace" },
          { id: "cmd-head", label: "npm *", match: { kind: "execute", commandPrefix: "npm" }, scope: "global" },
        ],
      });
    },
  },
  "question-card": {
    run: async ({ send }) => {
      await send({ type: "providerCapabilities", provider: "claude", capabilities: {} });
      await send({ type: "userMessage", text: "Add CSV export" });
      await send({ type: "agentStart" });
      await send({
        type: "questionRequest",
        autoContinueMs: 60_000,
        req: {
          id: 7,
          questions: [{
            question: "Should empty cells be exported as \"\" or left blank?",
            header: "Empty cells",
            options: [{ label: "Quoted empty string", description: "\"\" — explicit, Excel-safe" }, { label: "Blank", description: "Nothing between the commas" }],
            multiSelect: false,
          }],
        },
      });
    },
  },
  "host-notices": {
    height: 1150,
    run: async ({ send }) => {
      await send({ type: "hostNotice", level: "info", text: "Permission rule applied: **allow** `npm test` (workspace)." });
      await send({ type: "hostNotice", level: "warning", text: "Can't discard all: `src/export.ts` changed outside this session." });
      await send({
        type: "hostNotice", level: "warning", text: "Crew runs live in their own session.",
        action: { id: "openCrewWithGoal", label: "Open a new Crew session with this goal", goal: "ship it" },
      });
      await send({
        type: "hostNotice", level: "info",
        text: "Subagents diagnose\n\n- Subagents: on\n- Gemini: usable · read-only\n- Codex: needs login\n- Routing: 2 rules, 1 applies\n\nRun `/subagents` to see the roster.",
      });
    },
  },
};

// -------------------------------------------------------- settings scenes --

const PROVIDERS = [
  { id: "grok", label: "Grok", connected: false, models: [{ modelId: "grok-4.6" }] },
  { id: "claude", label: "Claude", connected: true, models: [{ modelId: "claude-opus-5" }, { modelId: "claude-sonnet-5" }] },
  { id: "codex", label: "Codex", connected: true, models: [{ modelId: "gpt-5.5" }] },
  { id: "gemini", label: "Gemini", connected: true, models: [] },
];

const role = (name, over = {}) => ({
  name,
  provider: "claude",
  providerLabel: "Claude",
  model: "claude-opus-5",
  mode: "agent",
  scope: "builtin",
  providerPinned: false,
  whenToUse: "Checking finished work against its briefing.",
  editable: true,
  draft: { name, provider: "claude", model: "claude-opus-5", mode: "agent", whenToUse: "Checking finished work against its briefing." },
  ...over,
});

const AGENTS_SNAPSHOT = {
  agentRolesHasProject: true,
  agentRolesCwd: "/repo",
  agentRoleProviders: PROVIDERS,
  agentRoles: [
    role("planner", { mode: "plan", whenToUse: "Turning an idea into an ordered step list." }),
    role("implementer", { whenToUse: "Writing the code a step asks for." }),
    role("reviewer", { scope: "project", overrides: "builtin", providerPinned: true, path: ".companions/agents/reviewer.md", mode: "plan" }),
    role("docs-writer", { scope: "global", providerPinned: true, provider: "gemini", providerLabel: "Gemini", model: "", path: "~/.companions/agents/docs-writer.md", whenToUse: "Updating README and docs after a change." }),
  ],
  agentRoleProblems: [".companions/agents/broken.md: line 3: `mode` must be agent or plan"],
  crewFlows: [
    { name: "default", roles: ["planner", "implementer", "reviewer"], verify: "npm test", reviewEvery: 2, scope: "project", path: ".companions/crews/default.md", draft: { name: "default", roles: ["planner", "implementer", "reviewer"], verify: "npm test", reviewEvery: 2 } },
  ],
  workflows: [
    { name: "idea-to-done", title: "Idea to done", whenToUse: "A feature or bug from a sentence.", scope: "builtin", hasStages: true, defaultGraph: false, isDefault: true,
      mermaid: "flowchart LR\n    plan --> implement --> review --> fix", stages: [
        { id: "plan", title: "Plan", role: "planner", profile: "read-only" },
        { id: "implement", title: "Implement", role: "implementer", profile: "scoped-edit" },
        { id: "review", title: "Review", role: "reviewer", profile: "read-only" },
      ],
      draft: { name: "idea-to-done", title: "Idea to done", stagesJson: { schemaVersion: 1, name: "idea-to-done" } },
      validation: { valid: true, errors: [], warnings: [] } },
    { name: "hotfix", title: "Hotfix", whenToUse: "A production bug with a known cause.", scope: "project", hasStages: true, defaultGraph: false, isDefault: false,
      mermaid: "flowchart LR\n    implement --> review", stages: [{ id: "implement", title: "Implement", role: "implementer" }],
      draft: { name: "hotfix", title: "Hotfix", stagesJson: { schemaVersion: 1, name: "hotfix" } },
      validation: { valid: false, errors: ["stage `review` names role `qa`, which does not exist"], warnings: ["no verify command"] } },
  ],
  defaultWorkflow: "idea-to-done",
  subagentsEnabled: true,
  crewStagesMayUseSubagents: false,
  efforts: ["low", "medium", "high", "xhigh"],
  subagentRoster: [
    { id: "gemini", label: "Gemini", status: "usable", enabled: true, allowWrite: false, defaultModel: "", maxEffort: "medium", notes: "fast and cheap, good for repo scans" },
    { id: "claude", label: "Claude", status: "usable", enabled: true, allowWrite: true, defaultModel: "claude-sonnet-5", maxEffort: "", notes: "" },
    { id: "codex", label: "Codex", status: "needs-login", enabled: false, allowWrite: true, defaultModel: "", maxEffort: "", notes: "" },
  ],
  subagentRouting: [
    { match: ["inspect", "overview", "map"], provider: "gemini", model: "", effort: "low" },
    { match: ["refactor"], provider: "claude", model: "claude-opus-5", effort: "high" },
  ],
};

const ADVANCED_SNAPSHOT = {
  ruleFiles: [
    { path: "/repo/AGENTS.md", label: "AGENTS.md", scope: "project", kind: "agents", providers: ["codex", "grok"], exists: true, bytes: 2412 },
    { path: "/repo/CLAUDE.md", label: "CLAUDE.md", scope: "project", kind: "claude", providers: ["claude"], exists: true, bytes: 18_220 },
    { path: "/repo/GEMINI.md", label: "GEMINI.md", scope: "project", kind: "gemini", providers: ["gemini"], exists: false },
    { path: "~/.claude/CLAUDE.md", label: "CLAUDE.md", scope: "global", kind: "claude", providers: ["claude"], exists: true, bytes: 640 },
  ],
  permissionRules: [
    { id: "socket-delete", action: "floor", scope: "floor", summary: "Delete commands on system paths", detail: "rm / del / Remove-Item targeting /, /usr, C:\\Windows, and other OS roots. User rules cannot override this.", source: "socket", deletable: false },
    { id: "socket-creds", action: "floor", scope: "floor", summary: "Writes to credential files", detail: ".env*, *.pem, id_rsa*, id_ed25519*, *.key. User rules cannot override this.", source: "socket", deletable: false },
    { id: "r1", action: "allow", scope: "workspace", summary: "allow execute npm test (workspace)", detail: "kind execute · command npm test…", source: "workspace", deletable: true },
    { id: "r2", action: "ask", scope: "global", summary: "ask edit **/package.json (global)", detail: "kind edit · path **/package.json", source: "global", deletable: true },
    { id: "r3", action: "deny", scope: "workspace", summary: "deny execute git push (workspace)", detail: "kind execute · command git push…", source: "workspace", deletable: true },
  ],
  permissionRulesOrderCopy: "Deny always wins. Otherwise the last matching rule decides.",
  permissionRulesPending: { path: ".grok/permissions.json", ruleCount: 3, hash: "abc" },
};

export const SETTINGS_SCENARIOS = {
  "settings-agents": { category: "agents", snapshot: AGENTS_SNAPSHOT },
  "settings-agents-role-open": {
    category: "agents",
    snapshot: AGENTS_SNAPSHOT,
    run: async ({ page }) => {
      await page.click('[data-role="reviewer"] button');
    },
  },
  "settings-agents-new-flow": {
    category: "agents",
    snapshot: AGENTS_SNAPSHOT,
    run: async ({ page }) => {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => /new (crew )?flow/i.test(b.textContent || ""));
        if (btn) btn.click();
      });
    },
  },
  "settings-agents-workflow-open": {
    category: "agents",
    snapshot: AGENTS_SNAPSHOT,
    run: async ({ page }) => {
      await page.evaluate(() => {
        const card = document.querySelector('[data-workflow="hotfix"] button, [data-name="hotfix"] button');
        if (card) card.click();
      });
    },
  },
  "settings-agents-generator": {
    category: "agents",
    snapshot: {
      ...AGENTS_SNAPSHOT,
      workflowGenerator: {
        status: "preview", requestId: "g1", progress: "",
        draft: { name: "csv-feature", title: "CSV feature", stagesJson: { schemaVersion: 1, name: "csv-feature" } },
        mermaid: "flowchart LR\n    plan --> implement --> review",
        validation: { valid: true, errors: [], warnings: ["stage `review` has no verify command"] },
      },
    },
    run: async ({ page }) => {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => /generate/i.test(b.textContent || ""));
        if (btn) btn.click();
      });
    },
  },
  "settings-agents-empty": {
    category: "agents",
    snapshot: { ...AGENTS_SNAPSHOT, agentRoles: [], crewFlows: [], workflows: [], subagentRouting: [], agentRoleProblems: [] },
  },
  "settings-agents-loading": {
    category: "agents",
    snapshot: { agentRoleProviders: PROVIDERS },
  },
  "settings-advanced": { category: "advanced", snapshot: ADVANCED_SNAPSHOT },
  "settings-advanced-empty": {
    category: "advanced",
    snapshot: { ruleFiles: [], permissionRules: [], permissionRulesOrderCopy: "Deny always wins. Otherwise the last matching rule decides." },
  },
  "settings-routines": {
    // An upstream page, kept here to prove the fork no longer restyles it.
    category: "routines",
    snapshot: { routines: [], routineProjects: [{ path: "/repo", name: "repo" }], routineModels: [] },
    run: async ({ page }) => {
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => /new routine|create/i.test(b.textContent || ""));
        if (btn) btn.click();
      });
    },
  },
};
