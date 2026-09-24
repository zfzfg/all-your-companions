---
name: test-first
title: Test first
when_to_use: Features with clear acceptance criteria that tests can pin down (TDD).
roles: planner, tester, implementer, reviewer, fixer
verify:
default_gate: manual
parallel: false
---
Plan, write failing tests, implement until they pass (verify command), review, fix.

<!-- companions:stages v1 -->
```json
{
  "schemaVersion": 1,
  "name": "test-first",
  "title": "Test first",
  "description": "Plan, write failing tests, implement until they pass (verify command), review, fix.",
  "whenToUse": "Features with clear acceptance criteria that tests can pin down (TDD).",
  "whenNotToUse": "UI polish or exploratory work where tests come later.",
  "defaults": {
    "gate": "manual",
    "worktree": false,
    "allowSubagents": false
  },
  "roles": {
    "planner": {
      "ref": "planner"
    },
    "tester": {
      "inline": {
        "whenToUse": "Write failing tests from a plan's acceptance criteria.",
        "systemPreamble": "You write tests only. You never implement the feature.",
        "mode": "agent"
      }
    },
    "implementer": {
      "ref": "implementer"
    },
    "reviewer": {
      "ref": "reviewer"
    },
    "fixer": {
      "ref": "fixer"
    }
  },
  "stages": [
    {
      "id": "plan",
      "title": "Plan",
      "role": "planner",
      "enabled": true,
      "profile": "read-only",
      "runMode": "plan",
      "target": {
        "effort": "high"
      },
      "contract": {
        "$ref": "#/contracts/plan"
      },
      "next": [
        {
          "to": "tests"
        }
      ]
    },
    {
      "id": "tests",
      "title": "Write tests",
      "role": "tester",
      "enabled": true,
      "profile": "scoped-edit",
      "scope": [
        "test/**",
        "tests/**",
        "__tests__/**",
        "spec/**",
        "**/*.test.*",
        "**/*.spec.*",
        "**/*_test.*",
        "**/test_*.*"
      ],
      "contract": {
        "$ref": "#/contracts/write-tests"
      },
      "next": [
        {
          "to": "implement"
        }
      ]
    },
    {
      "id": "implement",
      "title": "Implement",
      "role": "implementer",
      "enabled": true,
      "profile": "scoped-edit",
      "scopeFrom": [
        "plan.files",
        "tests.filesObserved"
      ],
      "contract": {
        "$ref": "#/contracts/implement"
      },
      "next": [
        {
          "to": "review"
        }
      ]
    },
    {
      "id": "review",
      "title": "Review",
      "role": "reviewer",
      "enabled": true,
      "profile": "read-only",
      "target": {
        "preferDifferentProviderThan": "implement"
      },
      "contract": {
        "$ref": "#/contracts/review"
      },
      "next": [
        {
          "when": {
            "verdict": [
              "pass"
            ],
            "verify": [
              "passed",
              "none"
            ]
          },
          "to": "$done"
        },
        {
          "when": {
            "verdict": [
              "changes_requested"
            ]
          },
          "to": "fix"
        },
        {
          "when": {
            "verify": [
              "failed"
            ]
          },
          "to": "fix"
        },
        {
          "when": {
            "verdict": [
              "blocked"
            ]
          },
          "to": "$pause",
          "reason": "Reviewer is blocked and needs you."
        }
      ]
    },
    {
      "id": "fix",
      "title": "Fix",
      "role": "fixer",
      "enabled": true,
      "profile": "scoped-edit",
      "scopeFrom": [
        "review.findings.files",
        "implement.filesObserved"
      ],
      "maxVisits": 2,
      "onMaxVisits": "$pause",
      "contract": {
        "$ref": "#/contracts/fix"
      },
      "next": [
        {
          "to": "review"
        }
      ]
    }
  ],
  "contracts": {
    "plan": {
      "purpose": "Turn the idea into an ordered plan a different model can implement without asking.",
      "inputs": [
        {
          "from": "idea",
          "as": "Goal"
        },
        {
          "from": "files.attached",
          "as": "Attached files"
        },
        {
          "from": "userNotes",
          "as": "Notes from the user"
        }
      ],
      "instructions": "Write an ordered plan. Each step has an id, a title, an acceptance criterion and the files it is likely to touch. Name risks and open questions. Do not edit anything.",
      "output": {
        "sections": [
          "Summary",
          "Plan",
          "Risks",
          "Open questions"
        ],
        "resultBlock": {
          "required": [
            "planSteps"
          ]
        }
      },
      "acceptance": "A later implementer can carry this out without asking what the steps are.",
      "forbidden": [
        "Editing files",
        "Running commands that modify the workspace"
      ]
    },
    "write-tests": {
      "purpose": "Write the tests the plan implies, before any implementation exists.",
      "inputs": [
        {
          "from": "idea",
          "as": "Goal"
        },
        {
          "from": "plan.planSteps",
          "as": "Plan steps and acceptance criteria"
        },
        {
          "from": "userNotes",
          "as": "Notes from the user"
        }
      ],
      "instructions": "Write tests for every acceptance criterion. They should fail now. Edit test files only. Run the verify command to see them fail.",
      "output": {
        "sections": [
          "Summary",
          "Tests",
          "Files touched"
        ],
        "resultBlock": {
          "required": [
            "summary",
            "filesChanged"
          ]
        }
      },
      "acceptance": "Each acceptance criterion has a test, and the tests fail for the right reason.",
      "forbidden": [
        "Implementing the feature",
        "Editing non-test files"
      ]
    },
    "implement": {
      "purpose": "Implement the plan steps in order; stay within scope; run the verify command if given.",
      "inputs": [
        {
          "from": "idea",
          "as": "Goal"
        },
        {
          "from": "plan.planSteps",
          "as": "Plan steps and acceptance criteria"
        },
        {
          "from": "plan.filesReported",
          "as": "Files the planner named"
        },
        {
          "from": "userNotes",
          "as": "Notes from the user"
        },
        {
          "from": "tests.filesObserved",
          "as": "Tests written first (make them pass)"
        }
      ],
      "instructions": "Carry out the plan in order. Stay inside the named files unless a deviation is unavoidable, and say so. Run the verify command if one is in this briefing. Make the tests written first pass without weakening them.",
      "output": {
        "sections": [
          "Summary",
          "Steps done",
          "Files touched",
          "Deviations",
          "Open questions"
        ],
        "resultBlock": {
          "required": [
            "summary",
            "filesChanged"
          ]
        }
      },
      "acceptance": "Every plan step is done or named as a deviation, with the files that changed.",
      "forbidden": [
        "Re-planning the feature",
        "Touching files outside scope without saying so"
      ]
    },
    "review": {
      "purpose": "Judge whether the implementation satisfies the plan and is safe to keep.",
      "inputs": [
        {
          "from": "idea",
          "as": "Goal"
        },
        {
          "from": "plan.planSteps",
          "as": "Plan steps and acceptance criteria"
        },
        {
          "from": "implement.summary",
          "as": "What the implementer says was done"
        },
        {
          "from": "implement.filesObserved",
          "as": "Files actually changed (host-observed)"
        },
        {
          "from": "implement.verify",
          "as": "Verify result"
        },
        {
          "from": "userNotes",
          "as": "Notes from the user"
        }
      ],
      "instructions": "Read the changed files and the diffs. Check every acceptance criterion. Look for regressions, missing error handling, and edits outside the plan. Do not edit.",
      "output": {
        "sections": [
          "Summary",
          "Findings",
          "Acceptance check",
          "Open questions"
        ],
        "resultBlock": {
          "required": [
            "verdict",
            "findings"
          ],
          "verdict": {
            "values": [
              "pass",
              "changes_requested",
              "blocked"
            ]
          },
          "findings": {
            "severity": [
              "blocker",
              "major",
              "minor",
              "nit"
            ]
          }
        }
      },
      "acceptance": "Every plan step is marked met / not met with a reason.",
      "forbidden": [
        "Editing files",
        "Running commands that modify the workspace",
        "Re-planning the feature"
      ]
    },
    "fix": {
      "purpose": "Resolve the review findings (blocker and major first); re-run verify.",
      "inputs": [
        {
          "from": "idea",
          "as": "Goal"
        },
        {
          "from": "review.findings",
          "as": "Review findings"
        },
        {
          "from": "review.verdict",
          "as": "Review verdict"
        },
        {
          "from": "implement.filesObserved",
          "as": "Files the implementer changed"
        },
        {
          "from": "implement.verify",
          "as": "Verify result"
        },
        {
          "from": "userNotes",
          "as": "Notes from the user"
        }
      ],
      "instructions": "Fix the findings, blocker and major first. Do not add features or unrelated refactors. Re-run verify if given.",
      "output": {
        "sections": [
          "Summary",
          "Fixed",
          "Not fixed",
          "Files touched"
        ],
        "resultBlock": {
          "required": [
            "summary",
            "filesChanged"
          ]
        }
      },
      "acceptance": "Each finding is fixed or named with a reason it was not.",
      "forbidden": [
        "New features",
        "Unrelated refactors"
      ]
    }
  },
  "start": [
    "plan"
  ]
}
```
