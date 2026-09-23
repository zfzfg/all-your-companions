import { describe, expect, it } from "vitest";
import { pickSttBackend, resolveOpenAiVoiceKey, parseFinalVoiceCommand, type SttPreference } from "../src/voice";

describe("pickSttBackend", () => {
  // Rows: no credential, xAI only, OpenAI only, both. Explicit choices are
  // deliberately literal expectations, not a copy of the selection algorithm.
  const expected = {
    grok: { auto: [undefined, "xai", "openai", "xai"], xai: [undefined, "xai", undefined, "xai"], openai: [undefined, undefined, "openai", "openai"] },
    codex: { auto: [undefined, "xai", "openai", "openai"], xai: [undefined, "xai", undefined, "xai"], openai: [undefined, undefined, "openai", "openai"] },
    claude: { auto: [undefined, "xai", "openai", "xai"], xai: [undefined, "xai", undefined, "xai"], openai: [undefined, undefined, "openai", "openai"] },
  };
  for (const provider of ["grok", "codex", "claude"] as const) {
    for (const preference of [undefined, "auto", "xai", "openai"] as Array<SttPreference | undefined>) {
      for (const [index, [hasXai, hasOpenAi]] of [[false, false], [true, false], [false, true], [true, true]].entries()) {
        it(`${provider}, ${preference ?? "default"}, xAI=${hasXai}, OpenAI=${hasOpenAi}`, () => {
          expect(pickSttBackend({ provider, preference, hasXai, hasOpenAi })).toBe(expected[provider][preference ?? "auto"][index]);
        });
      }
    }
  }
  it("preserves dictation for an existing xAI-only Codex user on upgrade", () => {
    expect(pickSttBackend({ provider: "codex", hasXai: true, hasOpenAi: false })).toBe("xai");
  });
});

describe("OpenAI key resolution", () => {
  it("prefers setting, trims values, then uses only OPENAI_API_KEY", () => {
    expect(resolveOpenAiVoiceKey({ setting: " key ", env: { OPENAI_API_KEY: "env" } })).toBe("key");
    expect(resolveOpenAiVoiceKey({ setting: " ", env: { OPENAI_API_KEY: " env " } })).toBe("env");
    expect(resolveOpenAiVoiceKey({ env: { XAI_API_KEY: "xai", GROK_VOICE_API_KEY: "grok", access_token: "oauth" } })).toBeUndefined();
    expect(resolveOpenAiVoiceKey({})).toBeUndefined();
  });
});

describe("finalized voice commands", () => {
  it("retains a partial send phrase as draft and sends only the finalized match", () => {
    expect(parseFinalVoiceCommand("fix it grok send", "fix it", "grok send")).toEqual({ text: "fix it grok send", send: false });
    expect(parseFinalVoiceCommand("fix it grok send", "fix it grok send", "grok send")).toEqual({ text: "fix it", send: true });
    expect(parseFinalVoiceCommand("fix it Grok said", "fix it Grok said", "grok send").send).toBe(false);
  });
});
