import { describe, expect, it } from "vitest";
import * as path from "node:path";
import {
  CODEX_ROLLOUT_TAIL_BYTES,
  rateLimitsFromRolloutTail,
  readCodexSubscriptionWindows,
  type CodexUsageFs,
} from "../src/codex-usage";
import { codexSubscriptionWindows, codexWindowLabel } from "../src/subscription-usage";

/** The record as Codex writes it, copied out of a real rollout on 2026-09-14. */
const tokenCount = (overrides: Record<string, unknown> = {}, timestamp = "2026-09-13T23:29:01.659Z") =>
  JSON.stringify({
    timestamp,
    ordinal: 671,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 11041643, output_tokens: 65979 }, model_context_window: 258400 },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: { used_percent: 50.0, window_minutes: 10080, resets_at: 1789818344 },
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: "0" },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: "prolite",
        rate_limit_reached_type: null,
        ...overrides,
      },
    },
  });

describe("codexSubscriptionWindows", () => {
  const limits = (over: Record<string, unknown> = {}) => ({
    primary: { used_percent: 50, window_minutes: 10080, resets_at: 1789818344 },
    secondary: null,
    ...over,
  });

  it("reads the weekly window Codex actually writes", () => {
    expect(codexSubscriptionWindows(limits(), "2026-09-13T23:29:01.659Z")).toEqual([{
      usedPercent: 50,
      label: "Weekly",
      periodType: "primary_10080m",
      periodEnd: "2026-09-19T11:45:44.000Z",
      observedAt: "2026-09-13T23:29:01.659Z",
    }]);
  });

  it("reports both windows when a plan has two", () => {
    const both = codexSubscriptionWindows(
      limits({ secondary: { used_percent: 12.5, window_minutes: 300, resets_at: 1789818344 } }),
      "2026-09-13T23:29:01.659Z",
    );
    expect(both.map((w) => `${w.label} ${w.usedPercent}`)).toEqual(["Weekly 50", "5-hour 12.5"]);
  });

  // used_percent is 0..100 here and 0..1 on Claude. Pinning a value that is
  // wrong by a factor of 100 in only one direction is the point of this one.
  it("treats used_percent as a percentage, not a fraction", () => {
    const [window] = codexSubscriptionWindows(limits({
      primary: { used_percent: 4, window_minutes: 10080, resets_at: 1789818344 },
    }), "2026-09-13T23:29:01.659Z");
    expect(window.usedPercent).toBe(4);
  });

  it("drops a window it does not understand rather than guessing", () => {
    const at = "2026-09-13T23:29:01.659Z";
    expect(codexSubscriptionWindows(limits({ primary: null }), at)).toEqual([]);
    expect(codexSubscriptionWindows(limits({ primary: { used_percent: "50", window_minutes: 10080 } }), at)).toEqual([]);
    expect(codexSubscriptionWindows(limits({ primary: { used_percent: 50 } }), at)).toEqual([]);
    expect(codexSubscriptionWindows(limits({
      primary: { used_percent: 50, window_minutes: 10080, resets_at: "soon" },
    }), at)).toEqual([]);
    expect(codexSubscriptionWindows(limits(), "not a date")).toEqual([]);
    expect(codexSubscriptionWindows(undefined, at)).toEqual([]);
  });

  it("keeps a window whose reset time Codex omits", () => {
    const [window] = codexSubscriptionWindows(limits({
      primary: { used_percent: 50, window_minutes: 10080, resets_at: null },
    }), "2026-09-13T23:29:01.659Z");
    expect(window.periodEnd).toBeUndefined();
    expect(window.usedPercent).toBe(50);
  });
});

describe("codexWindowLabel", () => {
  it("names the windows plans actually use", () => {
    expect(codexWindowLabel(300)).toBe("5-hour");
    expect(codexWindowLabel(1440)).toBe("Daily");
    expect(codexWindowLabel(10080)).toBe("Weekly");
  });

  it("says how long an unnamed window is instead of inventing a name", () => {
    expect(codexWindowLabel(30)).toBe("30-minute");
    expect(codexWindowLabel(180)).toBe("3-hour");
    expect(codexWindowLabel(4320)).toBe("3-day");
  });

  it("has no label for a length that is not one", () => {
    expect(codexWindowLabel(0)).toBeUndefined();
    expect(codexWindowLabel(-1)).toBeUndefined();
    expect(codexWindowLabel("10080")).toBeUndefined();
    expect(codexWindowLabel(undefined)).toBeUndefined();
  });
});

describe("rateLimitsFromRolloutTail", () => {
  it("takes the LAST snapshot in the chunk, which is the freshest", () => {
    const chunk = ["{\"partial\": tru", tokenCount({}, "2026-09-13T10:00:00.000Z"),
      tokenCount({ primary: { used_percent: 77, window_minutes: 10080, resets_at: 1789818344 } },
        "2026-09-13T23:29:01.659Z")].join("\n");
    const [window] = rateLimitsFromRolloutTail(chunk);
    expect(window.usedPercent).toBe(77);
    expect(window.observedAt).toBe("2026-09-13T23:29:01.659Z");
  });

  // A tail starts mid-file, so line one is a fragment by construction.
  it("drops the truncated first line instead of parsing it", () => {
    expect(rateLimitsFromRolloutTail('imestamp":"x","rate_limits":{"primary')).toEqual([]);
    expect(rateLimitsFromRolloutTail("")).toEqual([]);
  });

  it("ignores an event that merely mentions rate_limits", () => {
    const notUsage = JSON.stringify({
      timestamp: "2026-09-13T23:29:01.659Z",
      payload: { type: "agent_message", message: 'the response said "rate_limits" were hit' },
    });
    expect(rateLimitsFromRolloutTail(["", notUsage].join("\n"))).toEqual([]);
  });
});

/** A fake tree shaped exactly like `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. */
function fakeFs(tree: Record<string, string>): CodexUsageFs & { tails: string[] } {
  const files = new Set(Object.keys(tree).map((p) => p.replace(/\\/g, "/")));
  const dirs = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/"));
  }
  const tails: string[] = [];
  return {
    tails,
    readdirSync(dir) {
      const key = dir.replace(/\\/g, "/");
      if (!dirs.has(key)) throw new Error(`ENOENT ${dir}`);
      const names = new Set<string>();
      for (const entry of [...files, ...dirs]) {
        if (entry.startsWith(`${key}/`)) names.add(entry.slice(key.length + 1).split("/")[0]);
      }
      return [...names];
    },
    statSync(p) {
      const key = p.replace(/\\/g, "/");
      if (!dirs.has(key) && !files.has(key)) throw new Error(`ENOENT ${p}`);
      return { isDirectory: () => dirs.has(key) };
    },
    readTail(file) {
      const key = file.replace(/\\/g, "/");
      tails.push(key);
      return tree[key] ?? tree[file] ?? "";
    },
  };
}

const rollout = (day: string, stamp: string) =>
  `/home/.codex/sessions/${day}/rollout-${stamp}-01a09ce9-c008-7270-a08c-d644e8564bbe.jsonl`;

describe("readCodexSubscriptionWindows", () => {
  it("takes the newest rollout that carries a snapshot", () => {
    const fs = fakeFs({
      [rollout("2026/09/13", "2026-09-13T21-15-59")]:
        `x\n${tokenCount({ primary: { used_percent: 10, window_minutes: 10080, resets_at: 1789818344 } },
          "2026-09-13T21:43:32.623Z")}`,
      [rollout("2026/09/14", "2026-09-14T00-35-59")]:
        `x\n${tokenCount({ primary: { used_percent: 44, window_minutes: 10080, resets_at: 1789818344 } },
          "2026-09-14T01:02:03.000Z")}`,
    });
    const [window] = readCodexSubscriptionWindows({ codexHome: path.join("/home", ".codex"), fs });
    expect(window.usedPercent).toBe(44);
  });

  /** Measured in a real `~/.codex` on 2026-09-13, names and figures both. A
   *  rollout is named when its session STARTS and appended to until it ends, so
   *  a session begun at 23:51 was still writing at 00:51 the next morning while
   *  a session begun at 23:58 had already stopped at 22:27. Taking the
   *  later-NAMED file published 41% as the current account figure when Codex
   *  had recorded 55% — understated by fourteen points, and nothing on screen
   *  says so, because "Observed …" faithfully reports the stale event's time. */
  it("believes the newest EVENT, not the newest filename", () => {
    const fs = fakeFs({
      [rollout("2026/09/13", "2026-09-13T23-58-16")]:
        `x\n${tokenCount({ primary: { used_percent: 41, window_minutes: 10080, resets_at: 1789818344 } },
          "2026-09-13T22:27:00.733Z")}`,
      [rollout("2026/09/13", "2026-09-13T23-51-19")]:
        `x\n${tokenCount({ primary: { used_percent: 55, window_minutes: 10080, resets_at: 1789818344 } },
          "2026-09-14T00:51:12.297Z")}`,
    });
    const [window] = readCodexSubscriptionWindows({ codexHome: "/home/.codex", fs });
    expect(window.usedPercent).toBe(55);
    expect(window.observedAt).toBe("2026-09-14T00:51:12.297Z");
    // Which costs reading both, since the second one's freshness is only
    // knowable after it has been read.
    expect(fs.tails).toHaveLength(2);
  });

  // Same mechanism one directory up: a session that starts before midnight and
  // runs past it writes its newest event into the OLDER day's tree.
  it("crosses a day boundary the same way, by event and not by folder", () => {
    const fs = fakeFs({
      [rollout("2026/09/14", "2026-09-14T09-00-00")]:
        `x\n${tokenCount({ primary: { used_percent: 7, window_minutes: 10080, resets_at: 1789818344 } },
          "2026-09-14T09:01:00.000Z")}`,
      [rollout("2026/09/13", "2026-09-13T23-51-19")]:
        `x\n${tokenCount({ primary: { used_percent: 55, window_minutes: 10080, resets_at: 1789818344 } },
          "2026-09-14T10:00:00.000Z")}`,
    });
    expect(readCodexSubscriptionWindows({ codexHome: "/home/.codex", fs })[0].usedPercent).toBe(55);
  });

  // The session the user is sitting in has written nothing yet — which is
  // precisely when they open the popover to ask what is left.
  it("falls back past a rollout with no snapshot in it", () => {
    const fs = fakeFs({
      [rollout("2026/09/14", "2026-09-14T09-00-00")]: "x\n{\"timestamp\":\"2026-09-14T09:00:00.000Z\"}",
      [rollout("2026/09/14", "2026-09-14T00-35-59")]: `x\n${tokenCount()}`,
    });
    expect(readCodexSubscriptionWindows({ codexHome: "/home/.codex", fs })[0].usedPercent).toBe(50);
    expect(fs.tails).toHaveLength(2);
  });

  it("crosses a month and a year boundary in the right direction", () => {
    const fs = fakeFs({
      [rollout("2025/12/31", "2025-12-31T23-59-00")]:
        `x\n${tokenCount({ primary: { used_percent: 99, window_minutes: 10080, resets_at: 1789818344 } },
          "2025-12-31T23:59:30.000Z")}`,
      [rollout("2026/01/01", "2026-01-01T00-01-00")]:
        `x\n${tokenCount({ primary: { used_percent: 1, window_minutes: 10080, resets_at: 1789818344 } },
          "2026-01-01T00:01:30.000Z")}`,
    });
    expect(readCodexSubscriptionWindows({ codexHome: "/home/.codex", fs })[0].usedPercent).toBe(1);
  });

  // Every failure is the same answer, because "we could not read this" and
  // "there is nothing yet" look identical to the person reading the panel.
  it("answers nothing rather than throwing when the tree is absent", () => {
    expect(readCodexSubscriptionWindows({ codexHome: "/nope", fs: fakeFs({}) })).toEqual([]);
  });

  it("stops after a bounded number of files", () => {
    const tree: Record<string, string> = {};
    for (let i = 0; i < 40; i++) {
      tree[rollout("2026/09/14", `2026-09-14T00-${String(i).padStart(2, "0")}-00`)] = "x\n{}";
    }
    const fs = fakeFs(tree);
    expect(readCodexSubscriptionWindows({ codexHome: "/home/.codex", fs })).toEqual([]);
    expect(fs.tails.length).toBeLessThanOrEqual(8);
  });

  it("only ever reads a bounded tail, never a whole rollout", () => {
    let asked = -1;
    const fs = fakeFs({ [rollout("2026/09/14", "2026-09-14T00-35-59")]: `x\n${tokenCount()}` });
    const spy: CodexUsageFs = { ...fs, readTail: (file, bytes) => { asked = bytes; return fs.readTail(file, bytes); } };
    readCodexSubscriptionWindows({ codexHome: "/home/.codex", fs: spy });
    expect(asked).toBe(CODEX_ROLLOUT_TAIL_BYTES);
  });
});
