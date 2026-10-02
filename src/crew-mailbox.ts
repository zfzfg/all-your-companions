/**
 * Host mailbox for one root run.
 *
 * A message is queued until the target reads it. Reading marks it delivered.
 * The same id is not applied twice. A message never starts a turn on a
 * finished worker. The sender id is whatever the host put here — the tool
 * argument is not trusted.
 *
 * The store is in memory. A reload drops queued messages rather than handing
 * them to a new attempt. Optional `load` rebuilds only messages whose attempt
 * still matches.
 */

export type MailboxState = "queued" | "delivered" | "acknowledged" | "rejected" | "expired";

export interface CrewMail {
  id: string;
  from: string;
  to: string;
  rootRunId: string;
  attemptId: string;
  type: string;
  at: number;
  body: string;
  state: MailboxState;
}

export interface CrewMailboxOpts {
  now?: () => number;
  maxBody?: number;
  maxQueued?: number;
  ttlMs?: number;
  /** Sends accepted per sender per minute. */
  ratePerMin?: number;
}

export type MailboxSendResult = { ok: true; mail: CrewMail } | { ok: false; reason: string };

const STATES = new Set<MailboxState>(["queued", "delivered", "acknowledged", "rejected", "expired"]);

export class CrewMailbox {
  private readonly mail = new Map<string, CrewMail>();
  private readonly sentAt = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly maxBody: number;
  private readonly maxQueued: number;
  private readonly ttlMs: number;
  private readonly ratePerMin: number;

  constructor(opts: CrewMailboxOpts = {}) {
    this.now = opts.now ?? (() => 0);
    this.maxBody = opts.maxBody ?? 4000;
    this.maxQueued = opts.maxQueued ?? 50;
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
    this.ratePerMin = opts.ratePerMin ?? 20;
  }

  send(input: Omit<CrewMail, "state" | "at"> & { at?: number }): MailboxSendResult {
    this.expire();
    const id = String(input.id ?? "").trim();
    const from = String(input.from ?? "").trim();
    const to = String(input.to ?? "").trim();
    const rootRunId = String(input.rootRunId ?? "").trim();
    const attemptId = String(input.attemptId ?? "").trim();
    if (!id || !from || !to || !rootRunId || !attemptId) return { ok: false, reason: "missing id, sender, target, run or attempt" };
    if (from === to) return { ok: false, reason: "a worker cannot mail itself" };
    const existing = this.mail.get(id);
    if (existing) return { ok: true, mail: existing };
    const body = String(input.body ?? "");
    if (body.length > this.maxBody) return { ok: false, reason: "message is over the size limit" };
    const queued = [...this.mail.values()].filter((item) => item.to === to && item.state === "queued").length;
    if (queued >= this.maxQueued) return { ok: false, reason: "mailbox is full" };
    const now = input.at ?? this.now();
    const recent = (this.sentAt.get(from) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= this.ratePerMin) return { ok: false, reason: "rate limit" };
    recent.push(now);
    this.sentAt.set(from, recent);
    const mail: CrewMail = {
      id,
      from,
      to,
      rootRunId,
      attemptId,
      type: String(input.type ?? "note").slice(0, 40) || "note",
      at: now,
      body,
      state: "queued",
    };
    this.mail.set(id, mail);
    return { ok: true, mail };
  }

  /**
   * Messages for `to` in this run and attempt, oldest first.
   * Queued messages become delivered. Expired and foreign attempts are not returned.
   */
  read(to: string, opts: { rootRunId: string; attemptId: string; after?: number; limit?: number }): CrewMail[] {
    this.expire();
    const after = opts.after ?? 0;
    const limit = Math.max(1, Math.min(50, opts.limit ?? 20));
    const rows = [...this.mail.values()]
      .filter((item) =>
        item.to === to
        && item.rootRunId === opts.rootRunId
        && item.attemptId === opts.attemptId
        && item.at > after
        && item.state !== "expired"
        && item.state !== "rejected",
      )
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    const page = rows.slice(0, limit);
    for (const item of page) {
      if (item.state === "queued") item.state = "delivered";
    }
    return page.map((item) => ({ ...item }));
  }

  acknowledge(id: string, by: string): MailboxSendResult {
    const item = this.mail.get(id);
    if (!item || item.to !== by) return { ok: false, reason: "no such message for this worker" };
    if (item.state === "acknowledged") return { ok: true, mail: { ...item } };
    if (item.state === "expired" || item.state === "rejected") return { ok: false, reason: item.state };
    item.state = "acknowledged";
    return { ok: true, mail: { ...item } };
  }

  reject(id: string, by: string): MailboxSendResult {
    const item = this.mail.get(id);
    if (!item || item.to !== by) return { ok: false, reason: "no such message for this worker" };
    if (item.state === "rejected") return { ok: true, mail: { ...item } };
    item.state = "rejected";
    return { ok: true, mail: { ...item } };
  }

  /** Replace the store from disk. Rows for a different attempt are dropped. */
  load(rows: readonly unknown[], liveAttempts: ReadonlyMap<string, string>): void {
    this.mail.clear();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const item = row as Partial<CrewMail>;
      if (!item.id || !item.to || !item.rootRunId || !item.attemptId || !item.from) continue;
      const live = liveAttempts.get(item.to);
      if (live && live !== item.attemptId) continue;
      const state = STATES.has(item.state as MailboxState) ? item.state as MailboxState : "queued";
      this.mail.set(item.id, {
        id: item.id,
        from: item.from,
        to: item.to,
        rootRunId: item.rootRunId,
        attemptId: item.attemptId,
        type: item.type || "note",
        at: typeof item.at === "number" ? item.at : 0,
        body: String(item.body ?? "").slice(0, this.maxBody),
        state,
      });
    }
  }

  snapshot(): CrewMail[] {
    return [...this.mail.values()].map((item) => ({ ...item }));
  }

  private expire(): void {
    const now = this.now();
    for (const item of this.mail.values()) {
      if (item.state === "queued" && now - item.at > this.ttlMs) item.state = "expired";
    }
  }
}
