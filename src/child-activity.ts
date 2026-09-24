/**
 * Live activity of a hidden child session, for the card that stands for it (X-02).
 *
 * A crew stage or companion subagent runs where nobody looks; this turns its
 * stream (prose, tool rows, thoughts, plan progress) into a small, coalesced
 * feed the visible ancestor renders on the stage row / subagent card. Live
 * only: it never enters a replay buffer — after a reload the child's own
 * transcript is the record.
 *
 * Pure: no vscode, no fs, no clock.
 */

export type ActivityItem =
  | { kind: "prose"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; id: string; title: string; status?: string; toolKind?: string }
  | { kind: "plan"; done: number; total: number; current?: string };

export interface ActivityOwner {
  kind: "stage" | "subagent";
  /** `<runId>:<stageId>` for a stage, the subagent id otherwise. */
  id: string;
}

/** Frames per second the host sends at most, per child. */
export const ACTIVITY_MAX_FPS = 4;
export const ACTIVITY_FLUSH_MS = Math.round(1000 / ACTIVITY_MAX_FPS);
/** Characters of prose / thought kept per item after coalescing. */
export const ACTIVITY_TEXT_CAP = 600;

type HostLike =
  | { type: "messageChunk"; text: string }
  | { type: "thoughtChunk"; text: string }
  | { type: "toolCall" | "toolCallUpdate"; call: { toolCallId?: string; title?: string; status?: string; kind?: string } }
  | { type: "planEntries"; entries: ReadonlyArray<{ content: string; status: string }> }
  | { type: string };

/** One host frame → one activity item, or null for everything else. */
export function activityItemFromHostMsg(msg: HostLike): ActivityItem | null {
  switch (msg.type) {
    case "messageChunk": {
      const text = (msg as { text?: unknown }).text;
      return typeof text === "string" && text ? { kind: "prose", text } : null;
    }
    case "thoughtChunk": {
      const text = (msg as { text?: unknown }).text;
      return typeof text === "string" && text ? { kind: "thought", text } : null;
    }
    case "toolCall":
    case "toolCallUpdate": {
      const call = (msg as { call?: { toolCallId?: string; title?: string; status?: string; kind?: string } }).call;
      if (!call?.toolCallId) return null;
      return {
        kind: "tool",
        id: call.toolCallId,
        // An update often carries no title; empty keeps the one the call had.
        title: String(call.title ?? "").trim(),
        ...(call.status ? { status: call.status } : {}),
        ...(call.kind ? { toolKind: call.kind } : {}),
      };
    }
    case "planEntries": {
      const entries = (msg as { entries?: ReadonlyArray<{ content: string; status: string }> }).entries ?? [];
      if (!entries.length) return null;
      const done = entries.filter((e) => e.status === "completed").length;
      const current = entries.find((e) => e.status === "in_progress")?.content;
      return { kind: "plan", done, total: entries.length, ...(current ? { current } : {}) };
    }
    default:
      return null;
  }
}

function clip(text: string): string {
  return text.length > ACTIVITY_TEXT_CAP ? `…${text.slice(-(ACTIVITY_TEXT_CAP - 1))}` : text;
}

/**
 * Merge a batch: adjacent prose (and adjacent thoughts) join into one item,
 * a tool row keeps only its latest state (in its first position), and only
 * the last plan snapshot survives.
 */
export function coalesceActivity(items: readonly ActivityItem[]): ActivityItem[] {
  const out: ActivityItem[] = [];
  const toolAt = new Map<string, number>();
  let planAt = -1;
  for (const item of items) {
    const last = out[out.length - 1];
    if ((item.kind === "prose" || item.kind === "thought") && last && last.kind === item.kind) {
      out[out.length - 1] = { kind: item.kind, text: clip(last.text + item.text) };
      continue;
    }
    if (item.kind === "tool") {
      const at = toolAt.get(item.id);
      if (at !== undefined) {
        const prev = out[at] as Extract<ActivityItem, { kind: "tool" }>;
        out[at] = { ...prev, ...item, title: item.title || prev.title };
        continue;
      }
      toolAt.set(item.id, out.length);
    }
    if (item.kind === "plan") {
      if (planAt >= 0) {
        out[planAt] = item;
        continue;
      }
      planAt = out.length;
    }
    out.push(item.kind === "prose" || item.kind === "thought" ? { ...item, text: clip(item.text) } : item);
  }
  return out;
}

const TOOL_VERBS: Record<string, string> = {
  edit: "Editing",
  read: "Reading",
  execute: "Running",
  search: "Searching",
  fetch: "Fetching",
};

/** The one line a collapsed block shows: "Editing src/auth.ts…". */
export function activityLastLine(items: readonly ActivityItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === "tool") {
      const title = item.title || item.toolKind || "tool";
      const running = !item.status || item.status === "pending" || item.status === "in_progress";
      const verb = item.toolKind && TOOL_VERBS[item.toolKind];
      if (running) return verb && !title.startsWith(verb) ? `${verb} ${title}…` : `${title}…`;
      return `${title}${item.status === "failed" ? " — failed" : ""}`;
    }
    if (item.kind === "prose") {
      const lines = item.text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length) return lines[lines.length - 1]!;
    }
    if (item.kind === "plan") {
      return item.current ? `Step ${Math.min(item.done + 1, item.total)}/${item.total}: ${item.current}` : `${item.done}/${item.total} steps done`;
    }
  }
  return "";
}
