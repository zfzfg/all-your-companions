// AP-10 briefing format — the artefact AP-11..AP-13 build on.
//
// The four properties pinned here are the ones the format is worth nothing
// without: determinism, coordinates from day one, paths-not-contents, and a
// render/parse round trip so "structured return" is a contract rather than a
// hope.
import { describe, expect, it } from "vitest";
import {
  BRIEFING_FORMAT_VERSION,
  RESULT_FORMAT,
  makeBriefing,
  parseResult,
  renderBriefing,
  reconcileFiles,
  renderResult,
  roleRunLine,
  normalizeResultPath,
  type Briefing,
} from "../src/briefing";
import { normalizeReviewPath } from "../src/review-center";
import type { AgentRole } from "../src/agent-roles";

const role: AgentRole = {
  name: "reviewer",
  provider: "claude",
  model: "claude-opus-5",
  effort: "high",
  mode: "agent",
  scope: ["src/**"],
  whenToUse: "Checking finished work against its briefing.",
  whenNotToUse: "On its own work, in its own thread.",
  systemPreamble: "You are reviewing, not fixing.",
  source: "project",
  path: ".companions/agents/reviewer.md",
};

const briefing: Briefing = makeBriefing({
  runId: "run-20260908-120000-x1",
  step: 3,
  goal: "Ship AP-10.",
  task: "Review the diff in src/briefing.ts against the acceptance criterion.",
  acceptance: "Every finding names a file and a line.",
  files: ["src/briefing.ts", "test/briefing.test.ts"],
  decisions: ["Runs live in globalStorage (18.1)."],
  forbidden: ["Do not edit any file."],
});

describe("renderBriefing is deterministic", () => {
  it("produces identical bytes on repeated renders", () => {
    expect(renderBriefing(briefing, role)).toBe(renderBriefing(briefing, role));
  });

  it("does not depend on the field order of its inputs", () => {
    const reordered = {
      returnFormat: briefing.returnFormat,
      forbidden: briefing.forbidden,
      decisions: briefing.decisions,
      files: briefing.files,
      acceptance: briefing.acceptance,
      task: briefing.task,
      goal: briefing.goal,
      step: briefing.step,
      runId: briefing.runId,
    } as Briefing;
    const roleReordered = { ...role } as AgentRole;
    expect(renderBriefing(reordered, roleReordered)).toBe(renderBriefing(briefing, role));
  });

  it("contains no timestamp — a brief must diff cleanly across a re-run", () => {
    const text = renderBriefing(briefing, role);
    expect(text).not.toMatch(/\b20\d\d-\d\d-\d\dT/);
    expect(text).not.toMatch(/GMT|UTC\+/);
  });
});

describe("renderBriefing content", () => {
  const text = renderBriefing(briefing, role);

  it("puts the role's system preamble first, ahead of the heading", () => {
    expect(text.startsWith("You are reviewing, not fixing.")).toBe(true);
    expect(text.indexOf("You are reviewing")).toBeLessThan(text.indexOf("# Briefing"));
  });

  it("carries runId and step in the heading AND in the machine stamp", () => {
    expect(text).toContain("# Briefing — reviewer · run run-20260908-120000-x1 · step 3");
    expect(text).toContain(`<!-- companions:briefing v${BRIEFING_FORMAT_VERSION}`);
    expect(text).toContain("run=run-20260908-120000-x1 step=3 role=reviewer provider=claude model=claude-opus-5");
  });

  it("has every section, in a fixed order", () => {
    const order = ["## Goal", "## Task — this step only", "## Acceptance", "## Files in scope",
      "## Already decided", "## Do not", "## Return format"];
    let at = -1;
    for (const heading of order) {
      const index = text.indexOf(heading);
      expect(index, heading).toBeGreaterThan(at);
      at = index;
    }
  });

  it("lists file PATHS and says they are paths, never contents", () => {
    expect(text).toContain("- src/briefing.ts");
    expect(text).toContain("These are paths, not contents");
  });

  it("states the run recipe so a same-provider crew is legible", () => {
    expect(text).toContain("Claude · claude-opus-5 · effort high · agent mode");
  });

  it("never leaves a heading with an empty list under it", () => {
    const bare = makeBriefing({ runId: "r", step: 1, task: "do a thing" });
    const rendered = renderBriefing(bare, { ...role, systemPreamble: undefined, scope: undefined });
    expect(rendered).toContain("- no specific files named");
    expect(rendered).toContain("- nothing recorded");
    expect(rendered).not.toMatch(/\n## [^\n]+\n\n\n/);
  });

  it("falls back to the canonical return format when none is given", () => {
    expect(makeBriefing({ runId: "r", step: 1, task: "t" }).returnFormat).toBe(RESULT_FORMAT);
  });

  it("de-duplicates a list but keeps the caller's order", () => {
    const dupes = makeBriefing({ runId: "r", step: 1, task: "t", files: ["b.ts", "a.ts", "b.ts"] });
    expect(dupes.files).toEqual(["b.ts", "a.ts"]);
  });
});

describe("roleRunLine", () => {
  it("says 'default model' rather than leaving a gap", () => {
    expect(roleRunLine({ ...role, model: undefined, effort: undefined, mode: undefined }))
      .toBe("Claude · default model · agent mode");
  });
});

describe("parseResult is tolerant", () => {
  it("reads the canonical four sections", () => {
    const result = parseResult([
      "## Summary",
      "Reviewed the diff.",
      "",
      "## Files touched",
      "- src/a.ts",
      "- src/b.ts",
      "",
      "## Open",
      "- the CRLF case",
      "",
      "## Failed",
      "- none",
    ].join("\n"));
    expect(result.summary).toBe("Reviewed the diff.");
    expect(result.files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.open).toEqual(["the CRLF case"]);
    expect(result.failed).toEqual([]);
  });

  it("treats a missing section as empty, never as an error", () => {
    const result = parseResult("## Summary\nDid it.\n");
    expect(result).toEqual({ summary: "Did it.", files: [], open: [], failed: [] });
  });

  it("keeps a plain-prose reply as the summary", () => {
    const result = parseResult("I looked at it and it is fine.");
    expect(result.summary).toBe("I looked at it and it is fine.");
    expect(result.files).toEqual([]);
  });

  it("accepts alternative headings a model reasonably writes", () => {
    const result = parseResult([
      "### Result",
      "Done.",
      "### Changed files",
      "* src/x.ts",
      "### Remaining",
      "1. docs",
      "### Blocked",
      "- the flaky test",
    ].join("\n"));
    expect(result.summary).toBe("Done.");
    expect(result.files).toEqual(["src/x.ts"]);
    expect(result.open).toEqual(["docs"]);
    expect(result.failed).toEqual(["the flaky test"]);
  });

  it("ends a section at an unrecognised heading instead of absorbing it", () => {
    const result = parseResult("## Failed\n- a real failure\n\n## Notes\n- just a note\n");
    expect(result.failed).toEqual(["a real failure"]);
  });

  it("reads every spelling of 'nothing here' as an empty list", () => {
    const result = parseResult("## Files touched\n- none\n## Open\n(none)\n## Failed\nN/A\n");
    expect(result.files).toEqual([]);
    expect(result.open).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("survives an empty reply", () => {
    expect(parseResult("")).toEqual({ summary: "", files: [], open: [], failed: [] });
  });

  it("normalizes CRLF", () => {
    expect(parseResult("## Summary\r\nfine\r\n").summary).toBe("fine");
  });

  it("de-duplicates a repeated path", () => {
    expect(parseResult("## Files touched\n- a.ts\n- a.ts\n").files).toEqual(["a.ts"]);
  });
});

describe("render/parse round trip", () => {
  it("re-reads a rendered result to the same structure", () => {
    const original = { summary: "Did the thing.", files: ["a.ts"], open: ["b"], failed: [] };
    const reparsed = parseResult(renderResult(original, ""));
    expect(reparsed).toEqual(original);
  });

  it("keeps the raw reply verbatim underneath the canonical shape", () => {
    const rendered = renderResult({ summary: "s", files: [], open: [], failed: [] }, "the model said this");
    expect(rendered).toContain("## Raw reply");
    expect(rendered).toContain("the model said this");
  });

  it("says so when the role returned no summary at all", () => {
    expect(renderResult({ summary: "", files: [], open: [], failed: [] }, ""))
      .toContain("(the role returned no summary)");
  });
});

describe("reconcileFiles — the self-report measured against the evidence", () => {
  it("splits claimed and observed into the three honest buckets", () => {
    expect(reconcileFiles(["a.ts", "docs.md"], ["a.ts", "secret.ts"])).toEqual({
      touched: ["a.ts"],
      unreported: ["secret.ts"],
      claimedOnly: ["docs.md"],
    });
  });

  it("orders by the host's record, not the model's", () => {
    // The observed list comes from the host's own diff blocks and its order is
    // stable across runs; a model's ordering is not.
    const { touched } = reconcileFiles(["z.ts", "a.ts"], ["a.ts", "z.ts"]);
    expect(touched).toEqual(["a.ts", "z.ts"]);
  });

  it("normalizes separators and a leading ./ before comparing", () => {
    expect(reconcileFiles(["./src/a.ts"], ["src\\a.ts"])).toEqual({
      touched: ["src/a.ts"],
      unreported: [],
      claimedOnly: [],
    });
  });

  it("normalizes exactly the way the review center does", () => {
    // Pinned rather than imported so briefing.ts stays free of the review
    // center's dependency chain — the same arrangement as countLineDiff
    // against computeLineDiff.
    for (const input of ["src\\a.ts", "./src/a.ts", "  src/a.ts  ", "a\\b\\c.ts", "", "./"]) {
      expect(normalizeResultPath(input), input).toBe(normalizeReviewPath(input));
    }
  });

  it("de-duplicates within each list", () => {
    expect(reconcileFiles(["a.ts", "./a.ts"], ["a.ts", "a.ts"]).touched).toEqual(["a.ts"]);
  });

  it("is empty all round for a read-only role that changed nothing", () => {
    expect(reconcileFiles([], [])).toEqual({ touched: [], unreported: [], claimedOnly: [] });
  });

  it("reports everything as unreported when the role listed nothing at all", () => {
    expect(reconcileFiles([], ["a.ts"]).unreported).toEqual(["a.ts"]);
  });
});

describe("renderResult with a reconciliation", () => {
  const result = { summary: "s", files: ["a.ts"], open: [], failed: [] };

  it("adds the two discrepancy sections only when there is a discrepancy", () => {
    const clean = renderResult(result, "", { touched: ["a.ts"], unreported: [], claimedOnly: [] });
    expect(clean).not.toContain("did not report");
    expect(clean).not.toContain("not observed");

    const dirty = renderResult(result, "", {
      touched: ["a.ts"],
      unreported: ["secret.ts"],
      claimedOnly: ["docs.md"],
    });
    expect(dirty).toContain("## Edits the role did not report");
    expect(dirty).toContain("- secret.ts");
    expect(dirty).toContain("## Reported but not observed");
    expect(dirty).toContain("- docs.md");
  });

  it("keeps the role's own list under its own heading, unchanged", () => {
    const dirty = renderResult(result, "", { touched: [], unreported: ["x.ts"], claimedOnly: [] });
    expect(dirty).toContain("## Files touched\n\n- a.ts");
  });

  it("stays backwards-compatible without a reconciliation", () => {
    expect(renderResult(result, "")).toBe(renderResult(result, "", undefined));
  });

  it("re-parses to the same four-section structure with the extra sections present", () => {
    const dirty = renderResult(result, "", { touched: [], unreported: ["x.ts"], claimedOnly: [] });
    // The extra headings are unrecognised, so they END the previous section
    // rather than being folded into it — `files` must not absorb them.
    expect(parseResult(dirty).files).toEqual(["a.ts"]);
    expect(parseResult(dirty).failed).toEqual([]);
  });
});
