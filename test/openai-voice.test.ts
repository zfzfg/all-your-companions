import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => {
  const sockets: any[] = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    handlers = new Map<string, Function[]>();
    sent: any[] = [];
    close = vi.fn();
    constructor(public url: string, public options: any) { sockets.push(this); }
    on(name: string, fn: Function) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), fn]); }
    emit(name: string, ...args: any[]) { this.handlers.get(name)?.forEach(fn => fn(...args)); }
    send(data: string) { this.sent.push(JSON.parse(data)); }
    event(ev: any) { this.emit("message", Buffer.from(JSON.stringify(ev)), false); }
  }
  return { sockets, Socket };
});
vi.mock("ws", () => ({ default: mock.Socket }));

import { OpenAiPcmVoiceStreamer, OpenAiTranscript, Pcm16To24Khz, openAiTranscriptionConfig } from "../src/openai-voice";
import { parseVoiceCommand } from "../src/voice";

function samples(values: number[]): Buffer {
  const b = Buffer.alloc(values.length * 2);
  values.forEach((v, i) => b.writeInt16LE(v, i * 2));
  return b;
}
function values(b: Buffer): number[] { return Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2)); }
function commit(ws: any, id: string, previous: string | null = null) { ws.event({ type: "input_audio_buffer.committed", item_id: id, previous_item_id: previous }); }
function final(ws: any, id: string, transcript: string) { ws.event({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript }); }
function delta(ws: any, id: string, delta: string) { ws.event({ type: "conversation.item.input_audio_transcription.delta", item_id: id, delta }); }
async function start() {
  const streamer = new OpenAiPcmVoiceStreamer();
  const started = streamer.start({ apiKey: "secret", keyterms: ["grok send"] });
  const ws = mock.sockets.at(-1);
  ws.emit("open");
  ws.event({ type: "session.updated" });
  await started;
  return { streamer, ws };
}

describe("16 to 24 kHz PCM", () => {
  it("interpolates signed LE samples at exactly 3:2, flushing the tail once", () => {
    const r = new Pcm16To24Khz();
    expect(values(Buffer.concat([r.write(samples([-3000, 0, 3000, 6000])), r.finish()]))).toEqual([-3000, -1000, 1000, 3000, 5000, 6000]);
    expect(r.finish().length).toBe(0);
  });
  it("is invariant to every byte boundary, including split samples and empty chunks", () => {
    const input = samples([-32768, 32767, 0, -21, 17, 500, -125]);
    const whole = new Pcm16To24Khz();
    const expected = Buffer.concat([whole.write(input), whole.finish()]);
    for (let split = 0; split <= input.length; split++) {
      const r = new Pcm16To24Khz();
      expect(Buffer.concat([r.write(input.subarray(0, split)), r.write(Buffer.alloc(0)), r.write(input.subarray(split)), r.finish()])).toEqual(expected);
    }
    const r = new Pcm16To24Khz();
    expect(Buffer.concat([...input].map(b => r.write(Buffer.from([b]))).concat(r.finish()))).toEqual(expected);
  });
  it("preserves one second of 1 kHz audio as 24000 samples without changing its pitch", () => {
    const r = new Pcm16To24Khz();
    const input = samples(Array.from({ length: 16000 }, (_, i) => Math.round(10000 * Math.sin(2 * Math.PI * i / 16))));
    const out = values(Buffer.concat([r.write(input), r.finish()]));
    expect(out).toHaveLength(24000);
    expect(out.filter((v, i) => i > 0 && v >= 0 && out[i - 1] < 0).length).toBe(999);
    expect(Math.max(...out)).toBe(10000);
  });
  it("rejects truncated samples at Stop", () => {
    const r = new Pcm16To24Khz(); r.write(Buffer.from([1]));
    expect(() => r.finish()).toThrow("incomplete PCM16");
  });
});

describe("model vocabulary", () => {
  it("uses live keywords and plural languages, sanitizing forbidden keyword characters", () => {
    expect(openAiTranscriptionConfig({ apiKey: "", language: "pl", keyterms: ["<T>\nfoo"] })).toEqual({ model: "gpt-live-transcribe", keywords: ["T  foo"], languages: ["pl"] });
  });
  it.each(["gpt-4o-transcribe", "gpt-4o-mini-transcribe"])("uses free-text prompt for %s", model => {
    expect(openAiTranscriptionConfig({ apiKey: "", model, language: "en", keyterms: ["useEffect"] })).toEqual({ model, language: "en", prompt: "Vocabulary: useEffect." });
  });
});

describe("OpenAI Realtime lifecycle", () => {
  beforeEach(() => { mock.sockets.length = 0; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("waits for configuration acknowledgement and sends converted PCM over the transcription WebSocket", async () => {
    const s = new OpenAiPcmVoiceStreamer();
    const started = s.start({ apiKey: "secret" });
    const ws = mock.sockets[0];
    let ready = false; void started.then(() => { ready = true; });
    ws.emit("open"); ws.event({ type: "session.created" });
    await Promise.resolve(); expect(ready).toBe(false);
    expect(ws.url).toBe("wss://api.openai.com/v1/realtime?intent=transcription");
    expect(ws.options.headers.Authorization).toBe("Bearer secret");
    expect(ws.sent[0].session.audio.input.format).toEqual({ type: "audio/pcm", rate: 24000 });
    expect(ws.sent[0].session.audio.input.turn_detection.type).toBe("server_vad");
    ws.event({ type: "session.updated" }); await started;
    expect(s.writePcm(samples([0, 3000, 6000]))).toBe(true);
    expect(values(Buffer.from(ws.sent.at(-1).audio, "base64"))).toEqual([0, 2000, 4000, 6000]);
    s.cancel();
  });

  it("assembles cumulative deltas, replaces them with finals, and never sends from a partial", async () => {
    const { streamer: s, ws } = await start();
    const events: any[] = []; const sends: string[] = [];
    s.on("partial", ev => { events.push(ev); if (ev.speechFinal && parseVoiceCommand(ev.text).send) sends.push(ev.text); });
    commit(ws, "a"); delta(ws, "a", "fix it "); delta(ws, "a", "grok send");
    expect(events.at(-1)).toEqual({ text: "fix it grok send", speechFinal: false });
    expect(sends).toEqual([]);
    final(ws, "a", "fix it Grok said");
    expect(sends).toEqual([]);
    commit(ws, "b", "a"); final(ws, "b", "grok send");
    expect(sends).toEqual(["fix it Grok said grok send"]);
    delta(ws, "b", "late stale delta");
    expect(s.transcript).toBe("fix it Grok said grok send");
    s.cancel();
  });

  it("supports final-only operation and out-of-order finals by item identity and audio order", async () => {
    const { streamer: s, ws } = await start(); const events: any[] = []; s.on("partial", ev => events.push(ev));
    commit(ws, "a"); commit(ws, "b", "a");
    final(ws, "b", "grok send");
    expect(events.at(-1).speechFinal).toBe(false);
    final(ws, "a", "first words");
    expect(events.at(-1)).toEqual({ text: "first words grok send", speechFinal: true });
    expect(s.finalizedTranscript).toBe(s.transcript);
    s.cancel();
  });

  it("waits for earlier item identity even if completion precedes commit metadata", () => {
    const t = new OpenAiTranscript();
    t.apply({ type: "conversation.item.input_audio_transcription.completed", item_id: "b", transcript: "second" });
    t.apply({ type: "input_audio_buffer.committed", item_id: "b", previous_item_id: "a" });
    expect(t.complete).toBe(false);
    t.apply({ type: "conversation.item.input_audio_transcription.completed", item_id: "a", transcript: "first" });
    t.apply({ type: "input_audio_buffer.committed", item_id: "a", previous_item_id: null });
    expect(t.text).toBe("first second"); expect(t.complete).toBe(true);
  });

  it("Stop disables VAD, flushes audio, commits it, and waits for all finals", async () => {
    const { streamer: s, ws } = await start();
    s.writePcm(samples([1, 2, 3])); commit(ws, "a");
    const stopped = s.stop(); expect(s.stop()).toBe(stopped);
    expect(ws.sent.at(-1).session.audio.input.turn_detection).toBeNull();
    expect(s.writePcm(samples([4]))).toBe(false);
    ws.event({ type: "session.updated" });
    expect(ws.sent.at(-1)).toEqual({ type: "input_audio_buffer.commit", event_id: "voice-stop-commit" });
    expect(Buffer.from(ws.sent.at(-2).audio, "base64").length).toBe(4800);
    commit(ws, "b", "a"); final(ws, "b", "tail");
    let done = false; void stopped.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(100); expect(done).toBe(false);
    final(ws, "a", "earlier");
    await expect(stopped).resolves.toBe("earlier tail");
    expect(ws.close).toHaveBeenCalledTimes(1);
  });

  it("cancel wins while stopping and ignores all late messages", async () => {
    const { streamer: s, ws } = await start(); const events: any[] = []; s.on("partial", e => events.push(e));
    s.writePcm(samples([1, 2])); const stopped = s.stop(); s.cancel();
    ws.event({ type: "session.updated" }); commit(ws, "a"); final(ws, "a", "do not send grok send"); ws.emit("close");
    await expect(stopped).resolves.toBe(""); expect(events).toEqual([]);
    expect(s.active).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancel", "stop"])("%s while connecting settles startup without waiting for a timeout", async action => {
    const s = new OpenAiPcmVoiceStreamer(); const started = s.start({ apiKey: "" });
    const rejection = expect(started).rejects.toThrow("cancelled");
    if (action === "cancel") s.cancel(); else await expect(s.stop()).resolves.toBe("");
    await rejection; expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a lost final without promoting a partial to finalized text", async () => {
    const { streamer: s, ws } = await start(); s.writePcm(samples([1, 2])); commit(ws, "a"); delta(ws, "a", "draft grok send");
    const rejection = expect(s.stop()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(8000); await rejection;
    expect(s.transcript).toBe("draft grok send"); expect(s.finalizedTranscript).toBe(""); expect(s.active).toBe(false);
  });

  it.each(["error", "close", "unexpected-response", "timeout"])("settles failed startup: %s", async failure => {
    const s = new OpenAiPcmVoiceStreamer(); const started = s.start({ apiKey: "secret" });
    const rejection = expect(started).rejects.toThrow(); const ws = mock.sockets[0];
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(8000);
    else if (failure === "unexpected-response") ws.emit(failure, {}, { statusCode: 401 });
    else ws.emit(failure, new Error("network failed"));
    await rejection; expect(s.active).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });

  it("reports an asynchronous service failure without opening a fallback socket", async () => {
    const { streamer: s, ws } = await start(); const errors: Error[] = []; s.on("error", e => errors.push(e));
    ws.event({ type: "error", error: { message: "quota exhausted" } });
    expect(errors[0].message).toContain("quota exhausted"); expect(mock.sockets).toHaveLength(1); expect(s.active).toBe(false);
  });

  it("fails a lost connection while waiting for Stop's final and clears its deadline", async () => {
    const { streamer: s, ws } = await start(); s.writePcm(samples([1, 2]));
    const rejected = expect(s.stop()).rejects.toThrow("closed before transcription finished");
    ws.emit("close"); await rejected;
    expect(vi.getTimerCount()).toBe(0); expect(mock.sockets).toHaveLength(1);
  });

  it("reports write errors and releases the socket", async () => {
    const { streamer: s, ws } = await start(); const errors: Error[] = []; s.on("error", e => errors.push(e));
    ws.send = () => { throw new Error("write failed"); };
    expect(s.writePcm(samples([1, 2]))).toBe(false);
    expect(errors[0].message).toBe("write failed"); expect(s.active).toBe(false);
  });

  it("rejects Stop when its final commit cannot be sent", async () => {
    const { streamer: s, ws } = await start(); s.writePcm(samples([1, 2]));
    const rejected = expect(s.stop()).rejects.toThrow("commit failed");
    const original = ws.send.bind(ws);
    ws.send = (data: string) => {
      if (JSON.parse(data).type === "input_audio_buffer.commit") throw new Error("commit failed");
      original(data);
    };
    ws.event({ type: "session.updated" }); await rejected;
    expect(s.active).toBe(false); expect(vi.getTimerCount()).toBe(0);
  });
});
