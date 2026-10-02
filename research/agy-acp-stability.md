# Antigravity CLI stability and official-kernel spike

Implementation basis: 2026-10-02, `grok-build-vscode`, provider identity `gemini`.
The installed native Windows CLI reports `agy 1.2.15`. No authenticated model
prompts were used for this work. CLI behavior is covered by deterministic fixtures;
this is not a live-service compatibility certification.

## Production boundary

`GeminiBackend` always launches the Node `agy-acp-adapter`, which translates ACP
v1 into the installed CLI's stream-json interface. It does not select native
`gemini --acp` or Google's official kernel. Native CLI plan mode is preserved;
full-access aliases map to `yolo`, other ordinary aliases to `agent`.

The FIFO turn lifecycle is queued → claimed → running → finalizing → terminal,
with cancellation allowed throughout. A claimed turn reserves ownership before
capability discovery awaits. Diff work belongs to that turn and cannot emit into
its successor. Child callbacks require current process identity. Cancellation,
session transitions, EOF and shutdown abort queued work; replacement waits for
actual exit, using hidden Windows process-tree termination. A shutdown timeout
blocks replacement instead of risking a second live process.

Open tools receive exactly one ACP-v1 failed terminal update with a cancellation
or incomplete termination reason before the prompt response. Unknown tool states
do not count as visible output. Empty successful results and code-zero exits
without a result report errors. Tool rejection messages request a model retry
without claiming a retry happened. Only an initial explicit effort-flag mismatch
can be retried once before visible output; there is no automatic continuation or
generic retry loop.

The agy CLI starts with `--dangerously-skip-permissions`. Generic ACP permission
and question handlers do not enforce CLI tool approvals. The existing plan-review
bridge remains; no unverified native permission/question transport was added.
Cancel-and-replace is not advertised as steering.

## Settings

Settings apply to newly created backends/adapter processes.

| Setting (`companions.antigravity.` prefix) | Default | Behavior |
|---|---|---|
| `toolRules` | `prompt` | Transient instructions; `off` disables them; `global` explicitly opts into creating a missing `~/.gemini/GEMINI.md`. Existing files, including empty files, are preserved. |
| `watchdogIdleTimeoutMs` | `0` | Disabled; enabled values must be at least 30000. Known human permission, question and plan waits pause it. A silent turn fails and its process stops; the next prompt may resume the persisted conversation. |
| `maxActiveTurns` | `0` | Disabled; positive values enable FIFO admission across clients in one extension host, including Crew/subagents. |
| `minStartSpacingMs` | `2000` | Minimum spacing between admitted starts when admission is enabled. |

These are local operating controls, not Google product limits or account-wide
coordination. Other editor windows have separate coordinators. Admission waiters
can be cancelled; permits are released on success, failure, cancellation and
disposal. Existing active clients retain their backend configuration.

Windows `.cmd`/`.bat` executable paths are quoted and child windows hidden. Old
one-shot CLI fallback requires a native executable on Windows, because user
prompt text must not be interpolated into shell arguments. Modern stream-json
supports command shims, including paths containing spaces.

## Models, skills, replay and usage

Live model discovery drives both the model menu and effort configuration, with
the known catalog as an offline fallback. Unknown model identifiers are preserved;
explicit reasoning-effort metadata controls offered values and CLI flags.

Workspace skill roots: `.agents/skills`, `.gemini/skills`, `.codex/skills`.
User roots: `~/.gemini/skills`, `~/.gemini/config/skills`, `~/.agents/skills`,
`~/.codex/skills`. Workspace definitions win; native/host commands win collisions.
Discovery requires valid name/description frontmatter, omits non-invocable skills,
ignores optional unreadable roots, and is bounded to 256 directories per root and
128 KiB per file. An explicit `/skill-name` adds a path-specific reading instruction
for up to eight skills, rather than claiming native skill execution. Transient
adapter instructions are stripped from transcript user text and titles.

Replay deduplicates complete records by line position and content hash within a
session generation. Identical text at different positions remains visible;
truncated records can be replayed after repair. New/load resets the generation.
Prompt billing stays usage metadata, never a synthesized context-occupancy signal.

## Optional official kernel probe

`research/agy-official-transport-probe.cjs` requires absolute paths to an already
installed official kernel and `localharness_external`. It never downloads binaries,
authenticates, sends model prompts or logs opaque kernel diagnostics. By default
it probes `initialize`; `--session` additionally creates a session and sends cancel.
It reports protocol version, agent version, capability/auth-method identifiers and,
when requested, mode identifiers. Auth method presence does not prove login works.

```powershell
$env:AGY_OFFICIAL_ACP_BIN = 'C:\installed\agy_acp_server.exe'
$env:AGY_OFFICIAL_HARNESS_PATH = 'C:\installed\localharness_external.exe'
node research/agy-official-transport-probe.cjs
# Optional, explicit session creation:
node research/agy-official-transport-probe.cjs --session
```

This machine's discovered `AppData/Local/agy/bin` contains the CLI executable,
not an official ACP kernel/harness pair. Consequently no native Windows kernel
compatibility or authenticated session result is asserted. The probe itself is
tested with a local Node fixture, including timeout, early exit and RPC errors.
No production transport flag/interface was added before that evidence exists.
Official `default`/`auto_edit`/`yolo` modes must not substitute for native CLI plan.
SQLite repair, MCP-name rewriting and automatic loop continuation remain outside
this implementation.

Provider setup logs a nonblocking account-terms reference. The applicable
[Google Antigravity terms](https://antigravity.google/terms) must be considered for
the account and product in use; local admission does not grant third-party access
rights or protect an account from service restrictions. No extra consent gate is
introduced.

## Regression coverage

`agy-turn-lifecycle.test.ts` covers pre-spawn cancellation, queue ownership,
late-process events, failed termination, session transitions, EOF/shutdown, tool
terminalization, delayed diffs, empty results, spawn/stream/stdin faults, transient
guidance, dynamic models, replay and paused watchdogs. `agy-cli-integration.test.ts`
runs a real local fake CLI via a platform command shim (native Windows `.cmd`
with spaces), then awaits process/stream teardown. `agy-lifecycle.test.ts` pins
POSIX escalation, hidden Windows taskkill, exit confirmation and ACP-v1 types.
Skills, admission across separate clients and the kernel probe each have dedicated
binary-free suites. Existing permission/question and provider lifecycle suites
remain part of the full gate. See [TESTS.md](../TESTS.md) for measured gate results.
