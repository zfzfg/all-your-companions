import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("node:fs", () => ({ readFileSync: () => Buffer.alloc(4096) }));
import { transcribeAudio } from "../src/voice-recorder";

afterEach(() => vi.unstubAllGlobals());
describe("explicit batch preference", () => {
  it.each(["xai", "openai"] as const)("transcribes with the pinned %s credential and endpoint", async backend => {
    const fetch = vi.fn(async () => ({ ok: true, text: async () => JSON.stringify({ text: "  final words  " }) }));
    vi.stubGlobal("fetch", fetch);
    await expect(transcribeAudio("recording.wav", "backend-key", undefined, backend)).resolves.toBe("final words");
    const [url, request] = fetch.mock.calls[0] as any;
    expect(url).toBe(backend === "openai" ? "https://api.openai.com/v1/audio/transcriptions" : "https://api.x.ai/v1/stt");
    expect(request.headers.Authorization).toBe("Bearer backend-key");
    expect(request.body.get("model")).toBe(backend === "openai" ? "gpt-4o-transcribe" : null);
    expect(request.body.get("file").size).toBe(4096);
  });

  it("gives OpenAI setup guidance on auth refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 401, text: async () => "" })));
    await expect(transcribeAudio("recording.wav", "bad-key", undefined, "openai")).rejects.toThrow("Codex / ChatGPT sign-in does not provide transcription API access");
  });
});
