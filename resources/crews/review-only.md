---
name: review-only
title: Review only
when_to_use: “Look at my changes” — a second reader on the diff or branch, without edits.
roles: reviewer
verify:
default_gate: manual
parallel: false
---
A careful review of the current changes; nobody writes.

<!-- companions:stages v1 -->
```json
{
  "schemaVersion": 1,
  "name": "review-only",
  "title": "Review only",
  "description": "A careful review of the current changes; nobody writes.",
  "whenToUse": "“Look at my changes” — a second reader on the diff or branch, without edits.",
  "whenNotToUse": "When you want the findings fixed too (use Idea to done).",
  "defaults": {
    "gate": "manual",
    "worktree": false,
    "allowSubagents": false
  },
  "roles": {
    "reviewer": {
      "ref": "reviewer"
    }
  },
  "stages": [
    {
      "id": "review",
      "title": "Review",
      "role": "reviewer",
      "enabled": true,
      "profile": "read-only",
      "contract": {
        "$ref": "#/contracts/review-diff"
      },
      "next": [
        {
          "to": "$done"
        }
      ]
    }
  ],
  "contracts": {
    "review-diff": {
      "purpose": "Review the current changes in the working tree as a careful second reader.",
      "inputs": [
        {
          "from": "idea",
          "as": "What to review, in the user's words"
        },
        {
          "from": "files.attached",
          "as": "Files the user attached"
        },
        {
          "from": "userNotes",
          "as": "Notes from the user"
        }
      ],
      "instructions": "Look at the uncommitted diff (git diff, git status) or the branch the user names. Look for bugs, regressions, missing error handling and risky edits. Every finding names a file and a line. Do not edit.",
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
      "acceptance": "Every finding names a file and a line.",
      "forbidden": [
        "Editing files",
        "Running commands that modify the workspace"
      ]
    }
  },
  "start": [
    "review"
  ]
}
```
