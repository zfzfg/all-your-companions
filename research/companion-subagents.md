# Companion subagents (AP-16) — P0 findings and open probes

Companion subagents are the host-owned, cross-provider delegation mechanism:
a main agent in an Agent session launches a fresh session on *any* eligible
provider through three MCP tools the host supplies. This note records what P0
established, what it could not, and how to establish the rest.

Read alongside `research/subagents.md`, which is about grok's **native**
`spawn_subagent` — a different mechanism that keeps working untouched.

## The three questions P0 had to answer

| Question | Decides | Probe |
|---|---|---|
| Does the provider consume host-supplied MCP servers over ACP? | `hostMcp` in `src/provider-capabilities.ts`; whether the provider can be a **main** agent with subagents, or needs the §6.4.4 fenced-block shim | `research/probe-acp-mcp.cjs <provider>` |
| Does the CLI surface an MCP server's `instructions` field to the model? | Whether the Appendix A.2 delegation primer reaches the model at all | same probe |
| Is a child session made read-only by the deny overlay alone, and does Plan mode stall? | The §6.5 step 4 read-only recipe per provider (D15) | `research/probe-read-only.cjs <provider> [--plan]` |
| Does a child session persist in the CLI's own store, and can it be reloaded? | §6.6 point 4: ask the CLI not to persist, or persist and rely on the host-side hide rule | `research/probe-child-persistence.cjs <provider>` |

All three probes share `research/acp-probe-lib.cjs`, which resolves each CLI
from the environment (`GROK_BIN`, `CODEX_PATH`, `CLAUDE_CODE_EXECUTABLE`,
`GEMINI_BIN`) rather than hardcoding one maintainer's paths, speaks enough ACP
to open a session, and answers the server→client requests so the CLI does not
stall waiting on the client.

## `hostMcp` — settled for three providers, open for one

`research/mcp-shapes.md` already measured host-supplied MCP servers passed
through ACP's own `session/new` `mcpServers` parameter on **grok, codex and
claude**, with an identical server and an identical prompt on all three. All
three advertised the tool, called it, and delivered its output back to the
model — the note's whole subject is the *shape* of the result, which presumes
the call worked. AP-05's `ask_user` server has ridden the same path in
production since then. That is direct evidence, not inference, so those three
cells are `yes`.

**`gemini` is `probe`, and deliberately so.** That measurement did not include
it, and the provider id covers two different CLIs (Antigravity and Gemini CLI)
which already diverge on `structuredPlan`. Guessing here would be a claim about
a wire protocol nobody has watched. Run:

    node research/probe-acp-mcp.cjs gemini

and record the result below. Until then `gemini` can be a subagent **child**
(`companionSubagentTarget: yes` — being a child needs nothing but a session
start with overrides) but is not given the `companions` server as a **parent**:
§6.4.1 says the host appends it only where `hostMcp` is not `no`, and a `probe`
cell means the primer and tools might be advertised into a void.

### `instructions` surfacing

Unknown for every provider — no probe in this repository has ever asked for it,
and the MCP specification makes `instructions` advisory, so a CLI may accept it
and drop it. This matters because §6.9 puts the **entire** delegation primer in
that one field. `probe-acp-mcp.cjs` tests it directly: the probe server returns
a marker string in `instructions` and the prompt asks the model to repeat any
server instructions verbatim. If a provider answers `NO_INSTRUCTIONS`, the
primer needs another channel for that provider and §6.9 has to be revisited
with the maintainer — do not silently move it into the tool descriptions, which
§2.1 point 2 caps at two or three sentences.

## Read-only enforcement (D15)

The **deny overlay is the floor** and Plan mode is only ever an extra layer on
top of it (§6.5 step 4, D15). P2 therefore ships the conservative recipe for
every provider:

> deny overlay always; `mode: "plan"` only when `providerCapability(provider,
> "planMode").state === "yes"` **and** this note records that Plan mode does not
> stall on plan approval for that provider.

No provider has that recording yet, so **P2 ships deny-overlay-only on all
four**. That is the safe direction: the overlay is what actually enforces
read-only, and adding Plan mode later is a widening, not a fix.

`probe-read-only.cjs` answers both halves in one run. It refuses every
`session/request_permission` and answers `fs/write_text_file` with an error,
asks the agent to overwrite a file, and then reads that file back from disk. If
the file changed anyway, the CLI writes through its own handles and the deny
overlay is **not** sufficient for that provider — a blocker for using it as a
write-capable or read-only child, and a finding for
`docs/internal/ACP-feedback.md`. With `--plan` it additionally sets Plan mode
first and reports whether the prompt turn ever ends.

## Child-session persistence (§6.6)

Also unrecorded per provider. The design does not depend on the answer — the
host-side hide rule (§6.6 points 1–3: `hiddenReason` in `grok.sessionMeta`, the
history filter, the sweep guard) works whether or not the CLI persists, and
cards are rebuilt from the run directory rather than from the child transcript
(§6.6 point 6). The probe exists so that "Open transcript" can be wired to the
cheapest working source per provider, and so a provider that offers a genuine
non-persisting session can be opted into it.

`probe-child-persistence.cjs` snapshots the CLI's own store before and after a
one-turn child session, reports which paths appeared and which of them contain
the turn's text, and separately tests whether `session/load` accepts the id.

## Results table — fill this in as probes run

Nothing below has been run on live CLIs yet. Record the date, the CLI build and
the raw dump path (`%TEMP%/probe-*.json`) with each row, the way
`research/mcp-shapes.md` does.

| Provider | `hostMcp` | `instructions` surfaced | deny overlay holds | Plan mode stalls | child persists | `session/load` |
|---|---|---|---|---|---|---|
| grok | yes (mcp-shapes.md) | — | — | — | — | — |
| codex | yes (mcp-shapes.md) | — | — | — | — | — |
| claude | yes (mcp-shapes.md) | — | — | — | — | — |
| gemini | **probe** | — | — | — | — | — |

## Implementation notes that departed from the spec

**The server is named `companions_subagents`, not `companions`.** §6.4.1 names
it `companions`, but AP-05's question server already claims exactly that name
(`ASK_USER_SERVER_NAME === "companions"` in `src/ask-user-protocol.ts`), and two
entries in one `mcpServers` list cannot share a name. The three TOOL names —
which are what the spec pins, and what the model actually sees — are unchanged.
Renaming the ask-user server instead would change the tool namespacing every
connected CLI has been seeing in production (`mcp__companions__ask_user`), which
is a bigger change than this one and outside AP-16's scope. Flag for the
maintainer; either name is a one-line change if the other is preferred.

**The delegation script stays up when its token is refused.**
`ask-user-server.cjs` exits on a `denied` handshake, which is right for it: a
question server whose host is gone has nothing left to do. This one does not.
The main agent's own session is still alive and still working, and killing the
MCP server mid-run makes the CLI report a dead server for a capability the agent
can simply do without — §6.4.1's rule is that losing the channel costs the
session its delegation tools and nothing else. Every later call answers "could
not reach the editor; continue alone and tell the user why".

**Read-only ships as deny-overlay-only on all four providers.** §6.5 step 4
allows Plan mode as an extra layer where `planMode` is `yes` AND this note says
Plan does not stall on approval. No provider has that recording yet, so P2 takes
the conservative branch everywhere. Adding Plan mode later is a widening, not a
fix — see the read-only section above.

## Open questions that P0 must not answer by guessing

These are §16's still-open items, restated with the probe that closes each:

1. Per provider: does host MCP work over ACP (`gemini` only), and does the CLI
   surface server `instructions` (all four)? → `probe-acp-mcp.cjs`
2. Per provider: is Plan mode usable as an extra read-only layer, or does it
   stall on plan approval? → `probe-read-only.cjs --plan`

Until a probe has run, the capability cell stays `probe` and the implementation
takes the conservative branch. That is the rule from section 0 of the spec: a
`probe` cell is a recorded absence of knowledge, not a soft `yes`.
