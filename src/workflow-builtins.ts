/**
 * The built-in workflows besides `idea-to-done` (C-14).
 *
 * Each is the source of truth for the runtime; the Markdown copies in
 * `resources/crews/<name>.md` are kept in lockstep by test, exactly like
 * `idea-to-done`. They reuse the idea-to-done contracts where the job is the
 * same and add their own where it is not.
 *
 * Pure data.
 */

import { IDEA_TO_DONE, type PromptContract, type WorkflowDefinition } from "./workflow";

const TEST_GLOBS = ["test/**", "tests/**", "__tests__/**", "spec/**", "**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.*"];

const C = IDEA_TO_DONE.contracts;

const REPRODUCE_CONTRACT: PromptContract = {
  purpose: "Reproduce the reported bug and pin it down before anyone fixes it.",
  inputs: [
    { from: "idea", as: "Bug report" },
    { from: "files.attached", as: "Attached files" },
    { from: "userNotes", as: "Notes from the user" },
  ],
  instructions:
    "Find where the bug lives and why. If the project has tests, add ONE failing test that shows the bug and nothing else. "
    + "Do not fix it. Name the files the fix will likely touch.",
  output: {
    sections: ["Summary", "Cause", "Failing test", "Likely fix location"],
    resultBlock: { required: ["summary", "filesChanged"] },
  },
  acceptance: "The cause is named with a file and line, and a failing test exists where tests are possible.",
  forbidden: ["Fixing the bug", "Editing anything but test files"],
};

const BUGFIX_FIX_CONTRACT: PromptContract = {
  purpose: "Fix the reproduced bug with the smallest change that makes the failing test pass.",
  inputs: [
    { from: "idea", as: "Bug report" },
    { from: "reproduce.summary", as: "What reproduction found" },
    { from: "reproduce.filesObserved", as: "Files the reproduction touched (host-observed)" },
    { from: "userNotes", as: "Notes from the user" },
  ],
  instructions: "Fix the cause, not the symptom. Keep the failing test; make it pass. Run the verify command if given.",
  output: {
    sections: ["Summary", "Fix", "Files touched"],
    resultBlock: { required: ["summary", "filesChanged"] },
  },
  acceptance: "The failing test passes and no other behaviour changed.",
  forbidden: ["New features", "Unrelated refactors", "Deleting or weakening the failing test"],
};

const REVIEW_DIFF_CONTRACT: PromptContract = {
  purpose: "Review the current changes in the working tree as a careful second reader.",
  inputs: [
    { from: "idea", as: "What to review, in the user's words" },
    { from: "files.attached", as: "Files the user attached" },
    { from: "userNotes", as: "Notes from the user" },
  ],
  instructions:
    "Look at the uncommitted diff (git diff, git status) or the branch the user names. Look for bugs, regressions, missing "
    + "error handling and risky edits. Every finding names a file and a line. Do not edit.",
  output: C.review!.output,
  acceptance: "Every finding names a file and a line.",
  forbidden: ["Editing files", "Running commands that modify the workspace"],
};

const RESEARCH_CONTRACT: PromptContract = {
  purpose: "Answer the question about this codebase from the code itself.",
  inputs: [
    { from: "idea", as: "Question" },
    { from: "files.attached", as: "Attached files" },
    { from: "userNotes", as: "Notes from the user" },
  ],
  instructions: "Read what you need, trace the flow, and cite files and lines. Do not edit.",
  output: {
    sections: ["Summary", "Findings", "Open questions"],
    resultBlock: { required: ["summary"] },
  },
  acceptance: "Every claim cites a file.",
  forbidden: ["Editing files", "Running commands that modify the workspace"],
};

const SUMMARY_CONTRACT: PromptContract = {
  purpose: "Turn the research into a short report the user can act on.",
  inputs: [
    { from: "idea", as: "Question" },
    { from: "research.summary", as: "Research notes" },
    { from: "research.openQuestions", as: "Open questions" },
  ],
  instructions: "Write the answer first, then the evidence. Keep it short. Do not edit.",
  output: {
    sections: ["Answer", "Evidence", "Next steps"],
    resultBlock: { required: ["summary"] },
  },
  acceptance: "The first paragraph answers the question.",
  forbidden: ["Editing files"],
};

const WRITE_TESTS_CONTRACT: PromptContract = {
  purpose: "Write the tests the plan implies, before any implementation exists.",
  inputs: [
    { from: "idea", as: "Goal" },
    { from: "plan.planSteps", as: "Plan steps and acceptance criteria" },
    { from: "userNotes", as: "Notes from the user" },
  ],
  instructions:
    "Write tests for every acceptance criterion. They should fail now. Edit test files only. Run the verify command to see them fail.",
  output: {
    sections: ["Summary", "Tests", "Files touched"],
    resultBlock: { required: ["summary", "filesChanged"] },
  },
  acceptance: "Each acceptance criterion has a test, and the tests fail for the right reason.",
  forbidden: ["Implementing the feature", "Editing non-test files"],
};

const TDD_IMPLEMENT_CONTRACT: PromptContract = {
  ...C.implement!,
  inputs: [
    ...C.implement!.inputs,
    { from: "tests.filesObserved", as: "Tests written first (make them pass)" },
  ],
  instructions: `${C.implement!.instructions} Make the tests written first pass without weakening them.`,
};

const REVIEWER = { ref: "reviewer" } as const;

export const BUGFIX: WorkflowDefinition = {
  schemaVersion: 1,
  name: "bugfix",
  title: "Bug fix",
  description: "Reproduce, fix until the verify command is green, review, address the review.",
  whenToUse: "A bug with a reproducible symptom.",
  whenNotToUse: "New features; bugs nobody can reproduce yet.",
  defaults: { gate: "manual", worktree: false, allowSubagents: false },
  roles: {
    reproducer: {
      inline: {
        whenToUse: "Pin a bug down and write one failing test for it.",
        systemPreamble: "You reproduce bugs. You may only add a failing test; you never fix.",
        mode: "agent",
      },
    },
    fixer: { ref: "fixer" },
    reviewer: REVIEWER,
  },
  stages: [
    { id: "reproduce", title: "Reproduce", role: "reproducer", enabled: true, profile: "scoped-edit", scope: TEST_GLOBS, contract: "reproduce", next: [{ to: "fix" }] },
    {
      id: "fix", title: "Fix", role: "fixer", enabled: true, profile: "scoped-edit", scopeFrom: ["reproduce.filesObserved"], maxVisits: 3, onMaxVisits: "$pause", contract: "fix",
      next: [
        { when: { verify: ["failed"] }, to: "fix", reason: "The verify command is still red." },
        { to: "review" },
      ],
    },
    {
      id: "review", title: "Review", role: "reviewer", enabled: true, profile: "read-only", target: { preferDifferentProviderThan: "fix" }, contract: "review",
      next: [
        { when: { verdict: ["pass"], verify: ["passed", "none"] }, to: "$done" },
        { when: { verdict: ["changes_requested"] }, to: "address" },
        { when: { verify: ["failed"] }, to: "address" },
        { when: { verdict: ["blocked"] }, to: "$pause", reason: "Reviewer is blocked and needs you." },
      ],
    },
    { id: "address", title: "Address review", role: "fixer", enabled: true, profile: "scoped-edit", scopeFrom: ["review.findings.files", "fix.filesObserved"], maxVisits: 2, onMaxVisits: "$pause", contract: "address", next: [{ to: "review" }] },
  ],
  contracts: {
    reproduce: REPRODUCE_CONTRACT,
    fix: BUGFIX_FIX_CONTRACT,
    review: {
      ...C.review!,
      inputs: [
        { from: "idea", as: "Bug report" },
        { from: "reproduce.summary", as: "What reproduction found" },
        { from: "fix.summary", as: "What the fixer says was done" },
        { from: "fix.filesObserved", as: "Files actually changed (host-observed)" },
        { from: "fix.verify", as: "Verify result" },
        { from: "userNotes", as: "Notes from the user" },
      ],
    },
    address: {
      ...C.fix!,
      inputs: [
        { from: "idea", as: "Bug report" },
        { from: "review.findings", as: "Review findings" },
        { from: "review.verdict", as: "Review verdict" },
        { from: "fix.filesObserved", as: "Files the fixer changed" },
        { from: "userNotes", as: "Notes from the user" },
      ],
    },
  },
  start: ["reproduce"],
  source: "builtin",
};

export const REVIEW_ONLY: WorkflowDefinition = {
  schemaVersion: 1,
  name: "review-only",
  title: "Review only",
  description: "A careful review of the current changes; nobody writes.",
  whenToUse: "“Look at my changes” — a second reader on the diff or branch, without edits.",
  whenNotToUse: "When you want the findings fixed too (use Idea to done).",
  defaults: { gate: "manual", worktree: false, allowSubagents: false },
  roles: { reviewer: REVIEWER },
  stages: [
    { id: "review", title: "Review", role: "reviewer", enabled: true, profile: "read-only", contract: "review-diff", next: [{ to: "$done" }] },
  ],
  contracts: { "review-diff": REVIEW_DIFF_CONTRACT },
  start: ["review"],
  source: "builtin",
};

export const RESEARCH: WorkflowDefinition = {
  schemaVersion: 1,
  name: "research",
  title: "Research",
  description: "Investigate the codebase read-only and write a short report.",
  whenToUse: "Questions about the codebase: how something works, where it lives, what a change would touch.",
  whenNotToUse: "Anything that should change files.",
  defaults: { gate: "manual", worktree: false, allowSubagents: false },
  roles: {
    researcher: { ref: "researcher" },
    summarizer: {
      inline: {
        whenToUse: "Write the short report from research notes.",
        systemPreamble: "You write concise reports. You never edit files.",
        mode: "agent",
      },
    },
  },
  stages: [
    { id: "research", title: "Research", role: "researcher", enabled: true, profile: "read-only", contract: "research", next: [{ to: "summary" }] },
    { id: "summary", title: "Summary", role: "summarizer", enabled: true, profile: "read-only", contract: "summary", next: [{ to: "$done" }] },
  ],
  contracts: { research: RESEARCH_CONTRACT, summary: SUMMARY_CONTRACT },
  start: ["research"],
  source: "builtin",
};

export const TEST_FIRST: WorkflowDefinition = {
  schemaVersion: 1,
  name: "test-first",
  title: "Test first",
  description: "Plan, write failing tests, implement until they pass (verify command), review, fix.",
  whenToUse: "Features with clear acceptance criteria that tests can pin down (TDD).",
  whenNotToUse: "UI polish or exploratory work where tests come later.",
  defaults: { gate: "manual", worktree: false, allowSubagents: false },
  roles: {
    planner: { ref: "planner" },
    tester: {
      inline: {
        whenToUse: "Write failing tests from a plan's acceptance criteria.",
        systemPreamble: "You write tests only. You never implement the feature.",
        mode: "agent",
      },
    },
    implementer: { ref: "implementer" },
    reviewer: REVIEWER,
    fixer: { ref: "fixer" },
  },
  stages: [
    { id: "plan", title: "Plan", role: "planner", enabled: true, profile: "read-only", runMode: "plan", target: { effort: "high" }, contract: "plan", next: [{ to: "tests" }] },
    { id: "tests", title: "Write tests", role: "tester", enabled: true, profile: "scoped-edit", scope: TEST_GLOBS, contract: "write-tests", next: [{ to: "implement" }] },
    { id: "implement", title: "Implement", role: "implementer", enabled: true, profile: "scoped-edit", scopeFrom: ["plan.files", "tests.filesObserved"], contract: "implement", next: [{ to: "review" }] },
    {
      id: "review", title: "Review", role: "reviewer", enabled: true, profile: "read-only", target: { preferDifferentProviderThan: "implement" }, contract: "review",
      next: [
        { when: { verdict: ["pass"], verify: ["passed", "none"] }, to: "$done" },
        { when: { verdict: ["changes_requested"] }, to: "fix" },
        { when: { verify: ["failed"] }, to: "fix" },
        { when: { verdict: ["blocked"] }, to: "$pause", reason: "Reviewer is blocked and needs you." },
      ],
    },
    { id: "fix", title: "Fix", role: "fixer", enabled: true, profile: "scoped-edit", scopeFrom: ["review.findings.files", "implement.filesObserved"], maxVisits: 2, onMaxVisits: "$pause", contract: "fix", next: [{ to: "review" }] },
  ],
  contracts: {
    plan: C.plan!,
    "write-tests": WRITE_TESTS_CONTRACT,
    implement: TDD_IMPLEMENT_CONTRACT,
    review: C.review!,
    fix: C.fix!,
  },
  start: ["plan"],
  source: "builtin",
};

export const REFACTOR_SAFE: WorkflowDefinition = {
  schemaVersion: 1,
  name: "refactor-safe",
  title: "Safe refactor",
  description: "Plan, implement one plan step at a time with a verify after each, review.",
  whenToUse: "Larger restructurings where each step should leave the project working.",
  whenNotToUse: "Small changes (use Idea to done).",
  defaults: { gate: "manual", worktree: false, allowSubagents: false },
  roles: {
    planner: { ref: "planner" },
    implementer: { ref: "implementer" },
    reviewer: REVIEWER,
    fixer: { ref: "fixer" },
  },
  stages: [
    { id: "plan", title: "Plan", role: "planner", enabled: true, profile: "read-only", runMode: "plan", target: { effort: "high" }, contract: "plan", next: [{ to: "implement" }] },
    { id: "implement", title: "Implement", role: "implementer", enabled: true, profile: "scoped-edit", scopeFrom: "plan.files", strategy: "per-plan-step", verifyEach: true, contract: "implement", next: [{ to: "review" }] },
    {
      id: "review", title: "Review", role: "reviewer", enabled: true, profile: "read-only", target: { preferDifferentProviderThan: "implement" }, contract: "review",
      next: [
        { when: { verdict: ["pass"], verify: ["passed", "none"] }, to: "$done" },
        { when: { verdict: ["changes_requested"] }, to: "fix" },
        { when: { verify: ["failed"] }, to: "fix" },
        { when: { verdict: ["blocked"] }, to: "$pause", reason: "Reviewer is blocked and needs you." },
      ],
    },
    { id: "fix", title: "Fix", role: "fixer", enabled: true, profile: "scoped-edit", scopeFrom: ["review.findings.files", "implement.filesObserved"], maxVisits: 2, onMaxVisits: "$pause", contract: "fix", next: [{ to: "review" }] },
  ],
  contracts: { plan: C.plan!, implement: C.implement!, review: C.review!, fix: C.fix! },
  start: ["plan"],
  source: "builtin",
};

/** Every built-in workflow besides idea-to-done, in picker order. */
export const MORE_BUILTIN_WORKFLOWS: readonly WorkflowDefinition[] = [BUGFIX, REVIEW_ONLY, RESEARCH, TEST_FIRST, REFACTOR_SAFE];

/** The `<!-- companions:stages v1 -->` JSON for a definition, contracts by $ref. */
export function stagesJsonFor(def: WorkflowDefinition): unknown {
  return {
    schemaVersion: def.schemaVersion,
    name: def.name,
    title: def.title,
    ...(def.description ? { description: def.description } : {}),
    whenToUse: def.whenToUse,
    ...(def.whenNotToUse ? { whenNotToUse: def.whenNotToUse } : {}),
    defaults: def.defaults,
    roles: def.roles,
    stages: def.stages.map((stage) => ({ ...stage, contract: { $ref: `#/contracts/${stage.contract}` } })),
    contracts: def.contracts,
    start: def.start,
  };
}

/** The Markdown file shipped in `resources/crews/` for a definition. */
export function workflowMarkdown(def: WorkflowDefinition): string {
  const roles = Object.keys(def.roles).join(", ");
  return [
    "---",
    `name: ${def.name}`,
    `title: ${def.title}`,
    `when_to_use: ${def.whenToUse}`,
    `roles: ${roles}`,
    "verify:",
    `default_gate: ${def.defaults.gate}`,
    "parallel: false",
    "---",
    def.description ?? "",
    "",
    "<!-- companions:stages v1 -->",
    "```json",
    JSON.stringify(stagesJsonFor(def), null, 2),
    "```",
    "",
  ].join("\n");
}
