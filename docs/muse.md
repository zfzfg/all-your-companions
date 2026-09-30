# Muse Code in All your Companions

Connect Muse in Settings → Providers. If it is missing, the host offers a confirmed installation in a visible terminal using Meta's platform installer. Installation does not grant provider consent. Existing Muse authentication is detected locally; actual authentication remains owned by the CLI.

Muse offers **Prompt unmatched**, **Full access**, and **On request**. A mode is shown and remembered only after Muse accepts it. Deny unmatched is hidden because it can block Muse's own reminder agent. Muse has no Plan or Steer capability. The extension does not use its own auto-accept path as a substitute for Muse approval.

Shell sandbox, sandbox network (`proxy-only`, `restricted`, `enabled`) and workspace trust are in Settings → Providers. They are captured at process creation and require a new conversation to change. Full access starts without the sandbox; On request requires a sandboxed process. Changing Full access back to Prompt unmatched does not retrofit a sandbox into the process.

On Windows/Linux, adapter and login environments default to `TBH_CREDENTIAL_BACKEND=file`. An explicit user value is preserved; macOS uses its existing Keychain behavior.

Account usage windows appear beside the existing conversation context budget. These measure different limits. Muse content, including messages between sessions, may be used for product improvement; the context popover repeats this notice.

Native Muse workflows use the native workflow cards, separate from Companion subagents and Crew. Prompts can wait behind Muse-owned turns without clearing pending approvals. Stop, transport failure and session teardown settle waiting requests. Locked sessions retry for at most ten seconds and stop when the adapter closes.
