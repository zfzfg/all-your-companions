/**
 * Questions from hidden children reach the person where they are looking (X-01).
 *
 * A crew stage or a companion subagent runs in a hidden child session. Its
 * permission, question and plan-approval cards used to land only in that
 * child's transcript — which nobody reads — so the child waited until its
 * timeout. The host now ALSO shows each such card in the nearest visible
 * ancestor, under an opaque route id, and routes the answer back.
 *
 * The table maps route ↔ (child, request id). Pure: no vscode, no fs, no clock.
 * Generic over the session type so it can be tested without a Session.
 */

export type RelayKind = "permissionRequest" | "questionRequest" | "exitPlanRequest";
export type ChildKind = "stage" | "subagent";

export interface RelayEntry<S> {
  route: string;
  child: S;
  ancestor: S;
  requestId: number | string;
  kind: RelayKind;
}

/** Where a relayed card came from, as the card shows it. */
export interface RelayOrigin {
  kind: ChildKind;
  /** `Stage "Implement" · Codex · gpt-5` */
  label: string;
  /** Opaque; the host resolves it. The webview never names a session. */
  route: string;
  /** "this stage" / "this subagent" — how a session-scoped grant reads here. */
  scopeWord: string;
  /** C-01: an edit that reaches outside the stage's scope. */
  outOfScope?: boolean;
}

export const RELAY_ROUTE_PREFIX = "relay-";

export function isRelayRoute(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(RELAY_ROUTE_PREFIX);
}

export class ChildRelayTable<S> {
  private readonly byRoute = new Map<string, RelayEntry<S>>();
  private readonly byChild = new Map<S, Map<string, string>>();
  private seq = 0;

  /** Register a child's request and return the route the ancestor's card carries. */
  open(child: S, ancestor: S, requestId: number | string, kind: RelayKind): string {
    const existing = this.routeFor(child, requestId);
    if (existing) return existing;
    this.seq += 1;
    const route = `${RELAY_ROUTE_PREFIX}${this.seq}`;
    this.byRoute.set(route, { route, child, ancestor, requestId, kind });
    let forChild = this.byChild.get(child);
    if (!forChild) {
      forChild = new Map();
      this.byChild.set(child, forChild);
    }
    forChild.set(String(requestId), route);
    return route;
  }

  routeFor(child: S, requestId: number | string): string | undefined {
    return this.byChild.get(child)?.get(String(requestId));
  }

  resolve(route: unknown): RelayEntry<S> | undefined {
    return isRelayRoute(route) ? this.byRoute.get(route) : undefined;
  }

  close(route: string): RelayEntry<S> | undefined {
    const entry = this.byRoute.get(route);
    if (!entry) return undefined;
    this.byRoute.delete(route);
    const forChild = this.byChild.get(entry.child);
    forChild?.delete(String(entry.requestId));
    if (forChild && forChild.size === 0) this.byChild.delete(entry.child);
    return entry;
  }

  /** Drop everything a child still had open (it ended, or was torn down). */
  closeChild(child: S): RelayEntry<S>[] {
    const routes = [...(this.byChild.get(child)?.values() ?? [])];
    return routes.map((route) => this.close(route)).filter((e): e is RelayEntry<S> => !!e);
  }

  pendingFor(child: S): number {
    return this.byChild.get(child)?.size ?? 0;
  }

  pendingIn(ancestor: S): RelayEntry<S>[] {
    return [...this.byRoute.values()].filter((entry) => entry.ancestor === ancestor);
  }

  all(): RelayEntry<S>[] {
    return [...this.byRoute.values()];
  }
}

/** `Stage "Implement" · Codex · gpt-5 wants to …` — the prefix a relayed card shows. */
export function relayOriginLabel(input: {
  kind: ChildKind;
  name: string;
  providerName?: string;
  model?: string;
}): string {
  const who = input.kind === "stage" ? `Stage "${input.name}"` : `Subagent "${input.name}"`;
  return [who, input.providerName, input.model].filter((part) => !!part && String(part).trim()).join(" · ");
}

export function relayScopeWord(kind: ChildKind): string {
  return kind === "stage" ? "this stage" : "this subagent";
}

/**
 * Rule suggestions for a relayed permission card. "Allow for this stage /
 * subagent" is a session-scoped grant, and the answer is routed to the child,
 * so the grant lives exactly as long as the child. Every concrete match is
 * offered that way first; the project-wide ones stay as they were.
 */
export function childScopedSuggestions<T extends { id: string; scope: string }>(suggestions: readonly T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (const s of suggestions) {
    if (s.scope === "session") {
      out.push(s);
      seen.add(s.id);
    }
  }
  for (const s of suggestions) {
    if (s.scope === "session") continue;
    const id = `child-${s.id}`;
    if (!seen.has(id)) {
      out.push({ ...s, id, scope: "session" });
      seen.add(id);
    }
  }
  for (const s of suggestions) if (s.scope !== "session") out.push(s);
  return out;
}

/** The one-line OS notification for an unfocused window. */
export function childNeedsYouNotice(kind: ChildKind, name: string, request: RelayKind): string {
  const what = request === "questionRequest"
    ? "has a question"
    : request === "exitPlanRequest" ? "needs your plan approval" : "needs your approval";
  return kind === "stage" ? `Crew stage ${name} ${what}.` : `Subagent "${name}" ${what}.`;
}
