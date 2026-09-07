---
description: Critical guidelines for Antigravity and Cortex tool usage
always_on: true
---

# Repository Instructions & Tool Guidelines

Import the repository instructions from `CLAUDE.md` instead of duplicating them.

## Antigravity Tool Usage Rules
1. **`write_to_file`**: Never include `ArtifactMetadata` when creating or modifying files in this workspace. `ArtifactMetadata` is strictly for internal brain artifacts (`.gemini/antigravity-cli/brain/`).
2. **`find_by_name`**: Always provide the `Pattern` argument (e.g. `Pattern: "*"`).
3. **Paths**: Always use absolute paths for file and directory tools.
