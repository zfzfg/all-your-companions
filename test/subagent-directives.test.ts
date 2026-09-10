/**
 * AP-16 §6.8 — subagent directives.
 *
 * The round trip is the contract: what the composer parses must serialise into
 * the prompt, and peel back out of a stored prompt as the same chips. A session
 * reopened months later shows chips, never the XML the host appended.
 */
import { describe, expect, it } from "vitest";
import {
  DIRECTIVE_BLOCK_TAG,
  directiveChipLabel,
  parseSubagentMentions,
  peelDirectiveBlock,
  renderDirectiveBlock,
  unfollowedDirectives,
  validateDirective,
  type SubagentDirective,
} from "../src/subagent-directives";

const world = (over: Partial<Parameters<typeof validateDirective>[1]> = {}) => ({
  usable: ["gemini", "claude"] as const,
  connected: ["gemini", "claude", "codex"] as const,
  enabled: () => true,
  knownRoles: ["inspector", "reviewer"],
  knownModels: () => ["m-fast", "m-strong"],
  modelsChecked: () => true,
  ...over,
});

describe("parsing the mention forms (§6.8)", () => {
  it("reads a bare @subagent as 'you may delegate, you pick'", () => {
    const parsed = parseSubagentMentions("Refactor auth @subagent");
    expect(parsed.directives).toEqual([{ id: "d1", strength: "prefer" }]);
    expect(parsed.text).toBe("Refactor auth");
  });

  it("reads a named provider as a must", () => {
    const parsed = parseSubagentMentions("@subagent:gemini map the tests");
    expect(parsed.directives[0]).toMatchObject({ strength: "must", provider: "gemini" });
    expect(parsed.text).toBe("map the tests");
  });

  it("reads a provider and model", () => {
    const parsed = parseSubagentMentions("@subagent:gemini/m-fast scan the repo");
    expect(parsed.directives[0]).toMatchObject({ provider: "gemini", model: "m-fast" });
  });

  it("reads an explicit effort", () => {
    const parsed = parseSubagentMentions("@subagent:claude effort:low check this");
    expect(parsed.directives[0]).toMatchObject({ provider: "claude", effort: "low" });
  });

  it("reads a role mention", () => {
    const parsed = parseSubagentMentions("@role:inspector first map every caller");
    expect(parsed.directives[0]).toMatchObject({ strength: "must", role: "inspector" });
  });

  it("reads @subagent:none as a forbid", () => {
    // Enforced by the host, not merely requested in the prompt.
    const parsed = parseSubagentMentions("just answer me @subagent:none");
    expect(parsed.directives).toEqual([{ id: "d1", strength: "forbid" }]);
  });

  it("accepts the @@ shortcut", () => {
    expect(parseSubagentMentions("@@subagent:gemini go").directives[0])
      .toMatchObject({ provider: "gemini" });
  });

  it("leaves a word it cannot resolve in the user's own text", () => {
    // More likely an email address or a handle than a directive, and eating it
    // would eat the user's words.
    const parsed = parseSubagentMentions("mail @subagent:someone-else about it");
    expect(parsed.directives).toEqual([]);
    expect(parsed.text).toBe("mail @subagent:someone-else about it");
  });

  it("leaves a bare @role alone — there is no role to use", () => {
    const parsed = parseSubagentMentions("what is @role anyway");
    expect(parsed.directives).toEqual([]);
    expect(parsed.text).toContain("@role");
  });

  it("drops an unrecognised option value rather than blocking the send", () => {
    const parsed = parseSubagentMentions("@subagent:gemini effort:turbo profile:root go");
    expect(parsed.directives[0].effort).toBeUndefined();
    expect(parsed.directives[0].profile).toBeUndefined();
    expect(parsed.directives[0].provider).toBe("gemini");
  });

  it("numbers several directives in one message", () => {
    const parsed = parseSubagentMentions("@subagent:gemini and @role:reviewer too");
    expect(parsed.directives.map((d) => d.id)).toEqual(["d1", "d2"]);
  });

  it("finds a directive at the very start of the message", () => {
    expect(parseSubagentMentions("@subagent:claude go").directives).toHaveLength(1);
  });

  it("does not treat an email address as a directive", () => {
    const parsed = parseSubagentMentions("ping someone@subagent.example.com");
    expect(parsed.directives).toEqual([]);
  });
});

describe("serialising into the prompt", () => {
  it("writes nothing when there are no directives", () => {
    expect(renderDirectiveBlock([])).toBe("");
  });

  it("writes a self-closing block for a forbid", () => {
    expect(renderDirectiveBlock([{ id: "d1", strength: "forbid" }]))
      .toBe(`<${DIRECTIVE_BLOCK_TAG} mode="forbid"/>`);
  });

  it("collapses to forbid even when a target was also named", () => {
    // A contradiction the model would otherwise have to resolve. "No subagents
    // on this message" is about the message, not about one worker.
    const block = renderDirectiveBlock([
      { id: "d1", strength: "must", provider: "gemini" },
      { id: "d2", strength: "forbid" },
    ]);
    expect(block).toContain('mode="forbid"');
    expect(block).not.toContain("gemini");
  });

  it("carries the for: text when the user wrote one", () => {
    const block = renderDirectiveBlock([
      { id: "d1", strength: "must", provider: "gemini", model: "m-fast", effort: "low", task: "scan the test suite" },
    ]);
    expect(block).toContain('provider="gemini"');
    expect(block).toContain("for: scan the test suite");
  });

  it("escapes a model id so it cannot break the block", () => {
    const block = renderDirectiveBlock([{ id: "d1", strength: "must", model: 'a"b<c' }]);
    expect(block).toContain("&quot;");
    expect(block).not.toContain('model="a"b');
  });
});

describe("peeling the block back out on restore", () => {
  it("round-trips a full directive", () => {
    const original: SubagentDirective[] = [{
      id: "d1",
      strength: "must",
      provider: "gemini",
      model: "m-fast",
      effort: "low",
      profile: "read-only",
      task: "scan the test suite and summarise coverage",
    }];
    const prompt = `Refactor the auth module\n${renderDirectiveBlock(original)}`;
    const peeled = peelDirectiveBlock(prompt);
    expect(peeled.directives).toEqual(original);
    // A reopened session shows chips, not XML.
    expect(peeled.text).toBe("Refactor the auth module");
  });

  it("round-trips a role directive", () => {
    const original: SubagentDirective[] = [{ id: "d1", strength: "must", role: "inspector" }];
    expect(peelDirectiveBlock(renderDirectiveBlock(original)).directives).toEqual(original);
  });

  it("round-trips a forbid", () => {
    const peeled = peelDirectiveBlock(`say hi\n${renderDirectiveBlock([{ id: "d1", strength: "forbid" }])}`);
    expect(peeled.forbid).toBe(true);
    expect(peeled.text).toBe("say hi");
  });

  it("leaves a prompt with no block untouched", () => {
    const peeled = peelDirectiveBlock("just a message");
    expect(peeled).toEqual({ directives: [], text: "just a message", forbid: false });
  });

  it("survives a block with an unknown attribute from a newer version", () => {
    const prompt = `<${DIRECTIVE_BLOCK_TAG}>\n  <directive id="d1" strength="must" provider="gemini" newthing="x"/>\n</${DIRECTIVE_BLOCK_TAG}>`;
    expect(peelDirectiveBlock(prompt).directives[0]).toMatchObject({ id: "d1", provider: "gemini" });
  });

  it("drops a directive with no id rather than inventing one", () => {
    const prompt = `<${DIRECTIVE_BLOCK_TAG}>\n  <directive strength="must" provider="gemini"/>\n</${DIRECTIVE_BLOCK_TAG}>`;
    expect(peelDirectiveBlock(prompt).directives).toEqual([]);
  });

  it("ignores a provider or effort a later version removed", () => {
    const prompt = `<${DIRECTIVE_BLOCK_TAG}>\n  <directive id="d1" strength="must" provider="openai" effort="turbo"/>\n</${DIRECTIVE_BLOCK_TAG}>`;
    const directive = peelDirectiveBlock(prompt).directives[0];
    expect(directive.provider).toBeUndefined();
    expect(directive.effort).toBeUndefined();
  });
});

describe("chip labels", () => {
  it("names the companion, model and effort", () => {
    expect(directiveChipLabel(
      { id: "d1", strength: "must", provider: "gemini", model: "m-fast", effort: "low" },
      () => "Gemini",
    )).toBe("⟢ Gemini · m-fast · low");
  });

  it("names a role directly", () => {
    expect(directiveChipLabel({ id: "d1", strength: "must", role: "inspector" })).toBe("⟢ inspector");
  });

  it("says 'any companion' when the user left the pick open", () => {
    expect(directiveChipLabel({ id: "d1", strength: "prefer" })).toBe("⟢ any companion");
  });

  it("renders a forbid as the none chip", () => {
    expect(directiveChipLabel({ id: "d1", strength: "forbid" })).toBe("⟢ none");
  });
});

describe("validation before send (§6.8)", () => {
  it("passes a directive whose target is ready", () => {
    expect(validateDirective({ id: "d1", strength: "must", provider: "gemini" }, world()))
      .toEqual({ ok: true });
  });

  it("offers Log in for a connected companion that needs one", () => {
    const result = validateDirective({ id: "d1", strength: "must", provider: "codex" }, world());
    expect(result).toMatchObject({ ok: false, fix: "log-in" });
  });

  it("says plainly when a companion is not connected at all", () => {
    const result = validateDirective(
      { id: "d1", strength: "must", provider: "grok" },
      world({ connected: [] as never }),
    );
    expect(result).toMatchObject({ ok: false, fix: "none" });
  });

  it("offers Enable in roster for a companion turned off for subagents", () => {
    const result = validateDirective(
      { id: "d1", strength: "must", provider: "gemini" },
      world({ enabled: () => false }),
    );
    expect(result).toMatchObject({ ok: false, fix: "enable-in-roster" });
  });

  it("offers Pick another model for a model that is gone", () => {
    const result = validateDirective(
      { id: "d1", strength: "must", provider: "gemini", model: "m-vanished" },
      world(),
    );
    expect(result).toMatchObject({ ok: false, fix: "pick-another-model" });
  });

  it("does NOT block a send on an unwarmed model cache", () => {
    // The same rule eligibility applies: not knowing the model list is not
    // evidence that the model is wrong, and blocking on it would be a guess.
    expect(validateDirective(
      { id: "d1", strength: "must", provider: "gemini", model: "m-unknown" },
      world({ modelsChecked: () => false }),
    )).toEqual({ ok: true });
  });

  it("refuses a role that does not exist", () => {
    expect(validateDirective({ id: "d1", strength: "must", role: "nobody" }, world()))
      .toMatchObject({ ok: false });
  });

  it("always passes a forbid — there is nothing to be ineligible", () => {
    expect(validateDirective({ id: "d1", strength: "forbid" }, world())).toEqual({ ok: true });
  });
});

describe("was the directive followed?", () => {
  it("flags a must whose companion was never used", () => {
    const unfollowed = unfollowedDirectives(
      [{ id: "d1", strength: "must", provider: "gemini" }],
      [{ provider: "claude" }],
    );
    expect(unfollowed.map((d) => d.id)).toEqual(["d1"]);
  });

  it("accepts a spawn on the named companion", () => {
    expect(unfollowedDirectives(
      [{ id: "d1", strength: "must", provider: "gemini" }],
      [{ provider: "gemini" }],
    )).toEqual([]);
  });

  it("checks the model too when one was named", () => {
    expect(unfollowedDirectives(
      [{ id: "d1", strength: "must", provider: "gemini", model: "m-fast" }],
      [{ provider: "gemini", model: "m-strong" }],
    )).toHaveLength(1);
  });

  it("matches a role directive by role", () => {
    expect(unfollowedDirectives(
      [{ id: "d1", strength: "must", role: "inspector" }],
      [{ provider: "gemini", role: "inspector" }],
    )).toEqual([]);
  });

  it("never flags a prefer — it is advice, and flagging it trains people to ignore the footer", () => {
    expect(unfollowedDirectives([{ id: "d1", strength: "prefer" }], [])).toEqual([]);
  });

  it("never flags a forbid, which is enforced elsewhere", () => {
    expect(unfollowedDirectives([{ id: "d1", strength: "forbid" }], [])).toEqual([]);
  });
});
