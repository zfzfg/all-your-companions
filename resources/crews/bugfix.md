---
name: bugfix
title: Bug fix
when_to_use: A bug with a reproducible symptom.
roles: reproducer, fixer, reviewer
verify:
default_gate: manual
parallel: false
---
Reproduce, fix until the verify command is green, review, address the review.

<!-- companions:stages v1 -->
```json
{
  "schemaVersion": 1,
  "name": "bugfix",
  "title": "Bug fix",
  "description": "Reproduce, fix until the verify command is green, review, address the review.",
  "whenToUse": "A bug with a reproducible symptom.",
  "whenNotToUse": "New features; bugs nobody can reproduce yet.",
  "defaults": {
    "gate": "manual",
    "worktree": false,
    "allowSubagents": false
  },
  "roles": {
    "reproducer": {
      "inline": {
        "whenToUse": "Pin a bug down and write one failing test for it.",
        "systemPreamble": "You reproduce bugs. You may only add a failing test; you never fix.",
        "mode": "agent"
      }
    },
    "fixer": {
      "ref": "fixer"
    },
    "reviewer": {
      "ref": "reviewer"
    }
  },
  "stages": [
    {
      "id": "reproduce",
      "title": "Reproduce",
      "role": "reproducer",
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
        "$ref": "#/contracts/reproduce"
      },
      "next": [
        {
          "to": "fix"
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
        "reproduce.filesObserved"
      ],
      "maxVisits": 3,
      "onMaxVisits": "$pause",
      "contract": {
        "$ref": "#/contracts/fix"
      },
      "next": [
        {
          "when": {
            "verify": [
              "failed"
            ]
          },
          "to": "fix",
          "reason": "The verify command is still red."
        },
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
        "preferDifferentProviderThan": "fix"
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
          "to": "address"
        },
        {
          "when": {
            "verify": [
              "failed"
            ]
          },
          "to": "address"
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
      "id": "address",
      "title": "Address review",
      "role": "fixer",
      "enabled": true,
      "profile": "scoped-edit",
      "scopeFrom": [
        "review.findings.files",
        "fix.filesObserved"
      ],
      "maxVisits": 2,
      "onMaxVisits": "$pause",
      "contract": {
        "$ref": "#/contracts/address"
      },
      "next": [
        {
          "to": "review"
        }
      ]
    }
  ],
  "contracts": {
    "reproduce": {
      "purpose": "Reproduce the reported bug and pin it down before anyone fixes it.",
      "inputs": [
        {
          "from": "idea",
          "as": "Bug report"
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
      "instructions": "Find where the bug lives and why. If the project has tests, add ONE failing test that shows the bug and nothing else. Do not fix it. Name the files the fix will likely touch.",
      "output": {
        "sections": [
          "Summary",
          "Cause",
          "Failing test",
          "Likely fix location"
        ],
        "resultBlock": {
          "required": [
            "summary",
            "filesChanged"
          ]
        }
      },
      "acceptance": "The cause is named with a file and line, and a failing test exists where tests are possible.",
      "forbidden": [
        "Fixing the bug",
        "Editing anything but test files"
      ]
    },
    "fix": {
      "purpose": "Fix the reproduced bug with the smallest change that makes the failing test pass.",
      "inputs": [
        {
          "from": "idea",
          "as": "Bug report"
        },
        {
          "from": "reproduce.summary",
          "as": "What reproduction found"
        },
        {
          "from": "reproduce.filesObserved",
          "as": "Files the reproduction touched (host-observed)"
        },
        {
          "from": "userNotes",
          "as": "Notes from the user"
        }
      ],
      "instructions": "Fix the cause, not the symptom. Keep the failing test; make it pass. Run the verify command if given.",
      "output": {
        "sections": [
          "Summary",
          "Fix",
          "Files touched"
        ],
        "resultBlock": {
          "required": [
            "summary",
            "filesChanged"
          ]
        }
      },
      "acceptance": "The failing test passes and no other behaviour changed.",
      "forbidden": [
        "New features",
        "Unrelated refactors",
        "Deleting or weakening the failing test"
      ]
    },
    "review": {
      "purpose": "Judge whether the implementation satisfies the plan and is safe to keep.",
      "inputs": [
        {
          "from": "idea",
          "as": "Bug report"
        },
        {
          "from": "reproduce.summary",
          "as": "What reproduction found"
        },
        {
          "from": "fix.summary",
          "as": "What the fixer says was done"
        },
        {
          "from": "fix.filesObserved",
          "as": "Files actually changed (host-observed)"
        },
        {
          "from": "fix.verify",
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
    "address": {
      "purpose": "Resolve the review findings (blocker and major first); re-run verify.",
      "inputs": [
        {
          "from": "idea",
          "as": "Bug report"
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
          "from": "fix.filesObserved",
          "as": "Files the fixer changed"
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
    "reproduce"
  ]
}
```
