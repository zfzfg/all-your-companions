---
name: idea-to-done
title: Idea to done
when_to_use: Features and changes that touch a handful of files and can be reviewed as one change.
roles: planner, implementer, reviewer, fixer
verify:
default_gate: manual
parallel: false
---
Plan, implement, review, and fix until the review passes. Fixer runs only
when the review requests changes or the verify command is red.

## Assumptions
- One implementer session for the whole plan.

<!-- companions:stages v1 -->
```json
{
  "schemaVersion": 1,
  "name": "idea-to-done",
  "title": "Idea to done",
  "description": "Plan, implement, review, and fix until the review passes.",
  "whenToUse": "Features and changes that touch a handful of files and can be reviewed as one change.",
  "whenNotToUse": "Pure research questions; large migrations that need per-step worktrees.",
  "defaults": {
    "gate": "manual",
    "worktree": false,
    "allowSubagents": false
  },
  "roles": {
    "planner": { "ref": "planner" },
    "implementer": { "ref": "implementer" },
    "reviewer": { "ref": "reviewer" },
    "fixer": { "ref": "fixer" },
    "clarifier": {
      "inline": {
        "whenToUse": "Ask the user the few questions that would change the plan.",
        "systemPreamble": "You ask questions only. You never plan or edit.",
        "mode": "plan"
      }
    }
  },
  "stages": [
    {
      "id": "clarify",
      "title": "Clarify",
      "role": "clarifier",
      "enabled": false,
      "profile": "read-only",
      "runMode": "plan",
      "contract": { "$ref": "#/contracts/clarify" },
      "next": [{ "to": "plan" }]
    },
    {
      "id": "plan",
      "title": "Plan",
      "role": "planner",
      "enabled": true,
      "profile": "read-only",
      "runMode": "plan",
      "target": { "effort": "high" },
      "contract": { "$ref": "#/contracts/plan" },
      "next": [{ "to": "implement" }]
    },
    {
      "id": "implement",
      "title": "Implement",
      "role": "implementer",
      "enabled": true,
      "profile": "scoped-edit",
      "scopeFrom": "plan.files",
      "strategy": "single-session",
      "contract": { "$ref": "#/contracts/implement" },
      "next": [{ "to": "review" }]
    },
    {
      "id": "review",
      "title": "Review",
      "role": "reviewer",
      "enabled": true,
      "profile": "read-only",
      "target": { "preferDifferentProviderThan": "implement" },
      "contract": { "$ref": "#/contracts/review" },
      "next": [
        { "when": { "verdict": ["pass"], "verify": ["passed", "none"] }, "to": "$done" },
        { "when": { "verdict": ["changes_requested"] }, "to": "fix" },
        { "when": { "verify": ["failed"] }, "to": "fix" },
        { "when": { "verdict": ["blocked"] }, "to": "$pause", "reason": "Reviewer is blocked and needs you." }
      ]
    },
    {
      "id": "fix",
      "title": "Fix",
      "role": "fixer",
      "enabled": true,
      "profile": "scoped-edit",
      "scopeFrom": ["review.findings.files", "implement.filesObserved"],
      "maxVisits": 2,
      "onMaxVisits": "$pause",
      "contract": { "$ref": "#/contracts/fix" },
      "next": [{ "to": "review" }]
    }
  ],
  "contracts": {
    "clarify": {
      "purpose": "Ask at most 5 questions whose answers would change the plan.",
      "inputs": [
        { "from": "idea", "as": "Goal" },
        { "from": "files.attached", "as": "Attached files" }
      ],
      "instructions": "You ask questions only. You never plan or edit. At most five questions.",
      "output": {
        "sections": ["Questions"],
        "resultBlock": { "required": ["questions"] }
      },
      "forbidden": ["Planning", "Editing files"]
    },
    "plan": {
      "purpose": "Turn the idea into an ordered plan a different model can implement without asking.",
      "inputs": [
        { "from": "idea", "as": "Goal" },
        { "from": "files.attached", "as": "Attached files" },
        { "from": "userNotes", "as": "Notes from the user" }
      ],
      "instructions": "Write an ordered plan. Each step has an id, a title, an acceptance criterion and the files it is likely to touch. Name risks and open questions. Do not edit anything.",
      "output": {
        "sections": ["Summary", "Plan", "Risks", "Open questions"],
        "resultBlock": { "required": ["planSteps"] }
      },
      "acceptance": "A later implementer can carry this out without asking what the steps are.",
      "forbidden": ["Editing files", "Running commands that modify the workspace"]
    },
    "implement": {
      "purpose": "Implement the plan steps in order; stay within scope; run the verify command if given.",
      "inputs": [
        { "from": "idea", "as": "Goal" },
        { "from": "plan.planSteps", "as": "Plan steps and acceptance criteria" },
        { "from": "plan.filesReported", "as": "Files the planner named" },
        { "from": "userNotes", "as": "Notes from the user" }
      ],
      "instructions": "Carry out the plan in order. Stay inside the named files unless a deviation is unavoidable, and say so. Run the verify command if one is in this briefing.",
      "output": {
        "sections": ["Summary", "Steps done", "Files touched", "Deviations", "Open questions"],
        "resultBlock": { "required": ["summary", "filesChanged"] }
      },
      "acceptance": "Every plan step is done or named as a deviation, with the files that changed.",
      "forbidden": ["Re-planning the feature", "Touching files outside scope without saying so"]
    },
    "review": {
      "purpose": "Judge whether the implementation satisfies the plan and is safe to keep.",
      "inputs": [
        { "from": "idea", "as": "Goal" },
        { "from": "plan.planSteps", "as": "Plan steps and acceptance criteria" },
        { "from": "implement.summary", "as": "What the implementer says was done" },
        { "from": "implement.filesObserved", "as": "Files actually changed (host-observed)" },
        { "from": "implement.verify", "as": "Verify result" },
        { "from": "userNotes", "as": "Notes from the user" }
      ],
      "instructions": "Read the changed files and the diffs. Check every acceptance criterion. Look for regressions, missing error handling, and edits outside the plan. Do not edit.",
      "output": {
        "sections": ["Summary", "Findings", "Acceptance check", "Open questions"],
        "resultBlock": {
          "required": ["verdict", "findings"],
          "verdict": { "values": ["pass", "changes_requested", "blocked"] },
          "findings": { "severity": ["blocker", "major", "minor", "nit"] }
        }
      },
      "acceptance": "Every plan step is marked met / not met with a reason.",
      "forbidden": ["Editing files", "Running commands that modify the workspace", "Re-planning the feature"]
    },
    "fix": {
      "purpose": "Resolve the review findings (blocker and major first); re-run verify.",
      "inputs": [
        { "from": "idea", "as": "Goal" },
        { "from": "review.findings", "as": "Review findings" },
        { "from": "review.verdict", "as": "Review verdict" },
        { "from": "implement.filesObserved", "as": "Files the implementer changed" },
        { "from": "implement.verify", "as": "Verify result" },
        { "from": "userNotes", "as": "Notes from the user" }
      ],
      "instructions": "Fix the findings, blocker and major first. Do not add features or unrelated refactors. Re-run verify if given.",
      "output": {
        "sections": ["Summary", "Fixed", "Not fixed", "Files touched"],
        "resultBlock": { "required": ["summary", "filesChanged"] }
      },
      "acceptance": "Each finding is fixed or named with a reason it was not.",
      "forbidden": ["New features", "Unrelated refactors"]
    }
  },
  "start": ["clarify", "plan"]
}
```
