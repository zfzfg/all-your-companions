# Remote session claim

> **Historical Reference Notice:** This document is retained for historical context only.
> Remote tab claiming, external relay sessions, and associated coordination mechanisms
> were removed in maintainability refactor W-14 to focus exclusively on local-first editor operation.

Remote tabs are mutually exclusive for one conversation. The newest tab that
**explicitly** asks for it wins; the previous holder is told and can take it
back by asking again.

There is no TTL, idle timer, lease, or relay stale sweep. A mobile browser
keeps thawing a background tab, which reconnects and posts `resumeSession`
automatically. That restore is indistinguishable from a rail click unless the
client sets an additive `claim?: boolean`. Only a claim transfers ownership
(`transferRemoteResume`). A non-claim conflict is refused with the same
`resumeFailed: { id }` as before, plus `code: "session-superseded"` so the
client can freeze the view and offer Continue here.

Host enforcement: once a tab's active mapping is gone, `REMOTE_REQUIRES_BOUND_SESSION`
messages are refused (`refuseUnboundRemoteSession`). `remoteSessionFor` must
not adopt or create for a demoted tab (`requiresExplicitSession`, survives
`identify` / `detachClient`).

The desk is not a rival tab. A live pool member, including `this.focused`, is
joined. A claim removes only the other tab's remote mapping.

See `src/sidebar.ts` (`findRemoteResumeTarget`, `transferRemoteResume`),
`src/remote-client-state.ts`, `src/protocol.ts` (`SESSION_SUPERSEDED_CODE`),
and `media/chat.js` (`postResumeSession`).
