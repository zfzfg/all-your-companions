// AP-10 run artefacts and the same-provider/different-model case.
//
// Two halves. The first drives AgentRunStore against a fake disk: where the
// brief and the result land, that step numbers pad, and that a run producing
// nothing is removed rather than left as a directory holding an unanswered
// brief. The second spawns the FAKE grok CLI twice — never a real binary — and
// proves the case §5.3.1 calls a main case: two roles, one provider, two
// models, no blending of transcript or usage.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AcpClient } from "../src/acp";
import { AgentRunStore, formatRunCost, makeRunId, stepSlug, type AgentRunFs } from "../src/agent-run";
import { parseResult, renderResult } from "../src/briefing";

function fakeFs(): { fs: AgentRunFs; files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    fs: {
      mkdirSync: (dir) => { dirs.add(dir); },
      writeFileSync: (file, data) => { files.set(file, data); },
      appendFileSync: (file, data) => { files.set(file, (files.get(file) ?? "") + data); },
      existsSync: (target) => dirs.has(target) || files.has(target),
      rmSync: (target) => {
        dirs.delete(target);
        for (const key of [...files.keys()]) if (key.startsWith(`${target}/`)) files.delete(key);
      },
    },
  };
}

function store(now = 1_757_000_000_000) {
  const disk = fakeFs();
  return {
    disk,
    store: new AgentRunStore({ root: "/store/runs", fs: disk.fs, now: () => now, join: (...p) => p.join("/") }),
  };
}

describe("run ids and step slugs", () => {
  it("stamps a sortable UTC id", () => {
    expect(makeRunId(Date.UTC(2026, 8, 8, 14, 12, 33), "a1")).toBe("run-20260908-141233-a1");
  });

  it("pads the step so a listing sorts past step 9", () => {
    expect(stepSlug(1)).toBe("step-01");
    expect(stepSlug(12)).toBe("step-12");
    // Stage 1 only ever writes step 1; nonsense still yields a valid name
    // rather than `step-NaN` in a directory a human has to read.
    expect(stepSlug(0)).toBe("step-01");
    expect(stepSlug(Number.NaN)).toBe("step-01");
  });

  it("never mints the same id twice inside one second", () => {
    const { store: runs } = store();
    const ids = new Set([runs.newRunId(), runs.newRunId(), runs.newRunId()]);
    expect(ids.size).toBe(3);
  });
});

describe("AgentRunStore", () => {
  it("writes the brief and the result where a human can find them", () => {
    const { store: runs, disk } = store();
    const brief = runs.writeBrief("run-1", 1, "# Briefing\n");
    const result = runs.writeResult("run-1", 1, "## Summary\n");
    expect(brief).toBe("/store/runs/run-1/step-01.brief.md");
    expect(result).toBe("/store/runs/run-1/step-01.result.md");
    expect(disk.files.get(brief)).toBe("# Briefing\n");
    expect(disk.files.get(result)).toBe("## Summary\n");
  });

  it("appends one JSON object per line to log.jsonl", () => {
    const { store: runs, disk } = store();
    runs.appendLog({ at: 1, runId: "run-1", step: 1, role: "reviewer", provider: "claude", event: "briefed" });
    runs.appendLog({ at: 2, runId: "run-1", step: 1, role: "reviewer", provider: "claude", event: "finished" });
    const lines = (disk.files.get("/store/runs/run-1/log.jsonl") ?? "").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["briefed", "finished"]);
  });

  it("discards a run that produced nothing, and is a no-op when there is none", () => {
    const { store: runs, disk } = store();
    runs.writeBrief("run-1", 1, "# Briefing\n");
    runs.discard("run-1");
    expect(disk.files.has("/store/runs/run-1/step-01.brief.md")).toBe(false);
    expect(() => runs.discard("never-existed")).not.toThrow();
  });
});

describe("formatRunCost", () => {
  it("converts grok's 10^10 ticks per USD", () => {
    expect(formatRunCost(12_300_000_000, 4210)).toBe("$1.23 · 4,210 tokens");
  });

  it("does not round a real charge away to zero", () => {
    expect(formatRunCost(1, undefined)).toBe("<$0.000001");
  });

  it("says 'no cost reported' rather than a reassuring $0.00", () => {
    // The distinction is the point: a provider that reported nothing is not a
    // provider that charged nothing, and printing the second would be a lie.
    expect(formatRunCost(undefined, undefined)).toBe("no cost reported");
    expect(formatRunCost(0, 0)).toBe("$0.00");
  });

  it("still reports tokens when only tokens are known", () => {
    expect(formatRunCost(undefined, 1200)).toBe("1,200 tokens");
  });
});

// ---------------------------------------------------------------------------
// Fake CLI — never a real binary (CLAUDE.md § test taxonomy, layer 1)
// ---------------------------------------------------------------------------

function fixtureCli(): string {
  const dir = path.join(__dirname, "fixtures");
  return process.platform === "win32"
    ? path.join(dir, "fake-grok-acp.cmd")
    : path.join(dir, "fake-grok-acp.sh");
}

const SUBPROCESS_WAIT_MS = 30_000;

describe("two roles, same provider, different models", () => {
  let workspace = "";
  let home = "";

  beforeAll(() => {
    if (process.platform !== "win32") {
      try { fs.chmodSync(path.join(__dirname, "fixtures", "fake-grok-acp.sh"), 0o755); } catch { /* best-effort */ }
    }
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-ws-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-home-"));
  });

  afterAll(() => {
    for (const dir of [workspace, home]) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  function client(): AcpClient {
    return new AcpClient({
      cliPath: fixtureCli(),
      cwd: workspace,
      env: { ...process.env, GROK_HOME: path.join(home, ".grok"), FAKE_UNIQUE_SESSION_IDS: "1" },
      log: () => {},
      grokVersion: "1.0.4",
      grokVersionVerified: true,
    });
  }

  it("keeps transcript, model and usage separate across the two role sessions", async () => {
    const roleA = client();
    const roleB = client();
    try {
      await roleA.start();
      await roleB.start();
      // The model is set on the newSession path, ahead of the first turn —
      // never a live switch on a running session, which is what
      // MODEL_SWITCH_INCOMPATIBLE_AGENT punishes.
      await roleA.newSession("role-a-model");
      await roleB.newSession("role-b-model");
      expect(roleA.sessionId).not.toBe(roleB.sessionId);

      const textA: string[] = [];
      const textB: string[] = [];
      roleA.on("messageChunk", (chunk: string) => textA.push(chunk));
      roleB.on("messageChunk", (chunk: string) => textB.push(chunk));

      const [metaA, metaB] = await Promise.all([
        roleA.prompt("SCENARIO_ROLE_REPLY"),
        roleB.prompt("SCENARIO_ROLE_REPLY"),
      ]);

      const parsedA = parseResult(textA.join(""));
      const parsedB = parseResult(textB.join(""));
      expect(parsedA.summary).toBe("Ran as role-a-model.");
      expect(parsedB.summary).toBe("Ran as role-b-model.");
      expect(parsedA.files).toEqual(["role-a-model.ts"]);
      expect(parsedB.files).toEqual(["role-b-model.ts"]);
      // No leakage in EITHER direction — the failure this guards against is a
      // shared buffer, which shows up as each side seeing both.
      expect(textA.join("")).not.toContain("role-b-model");
      expect(textB.join("")).not.toContain("role-a-model");

      // Usage is per session too: the fake bills by model-id length, so the
      // two must differ and neither may carry the other's number.
      expect(metaA?.usage?.costUsdTicks).toBe("role-a-model".length * 1000);
      expect(metaB?.usage?.costUsdTicks).toBe("role-b-model".length * 1000);
      expect(metaA?.modelId).toBe("role-a-model");
      expect(metaB?.modelId).toBe("role-b-model");
    } finally {
      roleA.dispose();
      roleB.dispose();
    }
  }, SUBPROCESS_WAIT_MS);

  it("writes a readable brief and result pair for such a run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-store-"));
    try {
      const runs = new AgentRunStore({
        root: path.join(dir, "runs"),
        fs: {
          mkdirSync: (target, options) => { fs.mkdirSync(target, options); },
          writeFileSync: (file, data) => fs.writeFileSync(file, data, "utf8"),
          appendFileSync: (file, data) => fs.appendFileSync(file, data, "utf8"),
          existsSync: (target) => fs.existsSync(target),
          rmSync: (target, options) => fs.rmSync(target, options),
        },
        join: (...parts) => path.join(...parts),
      });
      const runId = runs.newRunId();
      const briefPath = runs.writeBrief(runId, 1, "# Briefing — reviewer\n");
      const resultPath = runs.writeResult(
        runId,
        1,
        renderResult(parseResult("## Summary\nRan as role-a-model.\n"), "## Summary\nRan as role-a-model.\n"),
      );
      expect(fs.readFileSync(briefPath, "utf8")).toContain("# Briefing — reviewer");
      expect(fs.readFileSync(resultPath, "utf8")).toContain("Ran as role-a-model.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
