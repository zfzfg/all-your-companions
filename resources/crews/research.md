---
name: research
title: Research
when_to_use: Questions about the codebase: how something works, where it lives, what a change would touch.
roles: researcher, summarizer
verify:
default_gate: manual
parallel: false
---
Investigate the codebase read-only and write a short report.

<!-- companions:stages v1 -->
```json
{
  "schemaVersion": 1,
  "name": "research",
  "title": "Research",
  "description": "Investigate the codebase read-only and write a short report.",
  "whenToUse": "Questions about the codebase: how something works, where it lives, what a change would touch.",
  "whenNotToUse": "Anything that should change files.",
  "defaults": {
    "gate": "manual",
    "worktree": false,
    "allowSubagents": false
  },
  "roles": {
    "researcher": {
      "ref": "researcher"
    },
    "summarizer": {
      "inline": {
        "whenToUse": "Write the short report from research notes.",
        "systemPreamble": "You write concise reports. You never edit files.",
        "mode": "agent"
      }
    }
  },
  "stages": [
    {
      "id": "research",
      "title": "Research",
      "role": "researcher",
      "enabled": true,
      "profile": "read-only",
      "contract": {
        "$ref": "#/contracts/research"
      },
      "next": [
        {
          "to": "summary"
        }
      ]
    },
    {
      "id": "summary",
      "title": "Summary",
      "role": "summarizer",
      "enabled": true,
      "profile": "read-only",
      "contract": {
        "$ref": "#/contracts/summary"
      },
      "next": [
        {
          "to": "$done"
        }
      ]
    }
  ],
  "contracts": {
    "research": {
      "purpose": "Answer the question about this codebase from the code itself.",
      "inputs": [
        {
          "from": "idea",
          "as": "Question"
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
      "instructions": "Read what you need, trace the flow, and cite files and lines. Do not edit.",
      "output": {
        "sections": [
          "Summary",
          "Findings",
          "Open questions"
        ],
        "resultBlock": {
          "required": [
            "summary"
          ]
        }
      },
      "acceptance": "Every claim cites a file.",
      "forbidden": [
        "Editing files",
        "Running commands that modify the workspace"
      ]
    },
    "summary": {
      "purpose": "Turn the research into a short report the user can act on.",
      "inputs": [
        {
          "from": "idea",
          "as": "Question"
        },
        {
          "from": "research.summary",
          "as": "Research notes"
        },
        {
          "from": "research.openQuestions",
          "as": "Open questions"
        }
      ],
      "instructions": "Write the answer first, then the evidence. Keep it short. Do not edit.",
      "output": {
        "sections": [
          "Answer",
          "Evidence",
          "Next steps"
        ],
        "resultBlock": {
          "required": [
            "summary"
          ]
        }
      },
      "acceptance": "The first paragraph answers the question.",
      "forbidden": [
        "Editing files"
      ]
    }
  },
  "start": [
    "research"
  ]
}
```
