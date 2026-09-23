import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wsMock = vi.hoisted(() => {
  const sockets: any[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    readyState = FakeWebSocket.OPEN;
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    sent: unknown[] = [];
    closed = false;
    constructor() { sockets.push(this); }
    on(event: string, fn: (...args: any[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    send(data: unknown) { this.sent.push(data); }
    close() { this.closed = true; }
  }
  return { FakeWebSocket, sockets };
});

const childMock = vi.hoisted(() => {
  const processes: any[] = [];
  class FakeEmitter {
    handlers = new Map<string, Array<(...args: any[]) => void>>();
    on(event: string, fn: (...args: any[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: any[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
  }
  class FakeProcess extends FakeEmitter {
    stdout = new FakeEmitter();
    stderr = new FakeEmitter();
    stdin = { write: vi.fn(), end: vi.fn() };
    kill = vi.fn();
  }
  const spawn = vi.fn(() => {
    const proc = new FakeProcess();
    processes.push(proc);
    return proc;
  });
  return { processes, spawn };
});

vi.mock("ws", () => ({ default: wsMock.FakeWebSocket }));
vi.mock("node:child_process", () => ({ spawn: childMock.spawn }));

import { PcmVoiceStreamer, VoiceStreamer } from "../src/voice-streamer";

describe("PcmVoiceStreamer startup", () => {
  beforeEach(() => { wsMock.sockets.length = 0; });

  it("passes language and keyterms into the streaming URL", async () => {
    const logs: string[] = [];
    const streamer = new PcmVoiceStreamer();
    const started = streamer.start({
      apiKey: "test",
      language: "pl",
      keyterms: ["grok send", "Get-ChildItem"],
      log: (message) => logs.push(message),
    });
    wsMock.sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "transcript.created" })), false);

    await started;
    expect(logs[0]).toContain("language=<redacted>");
    expect(logs[0]).toContain("keyterm=<redacted>");
    expect(logs[0]).not.toContain("language=pl");
    expect(logs[0]).not.toContain("grok+send");
    expect(logs[0]).not.toContain("Get-ChildItem");
    streamer.cancel();
  });

  it("rejects when the socket closes cleanly before transcript.created", async () => {
    const streamer = new PcmVoiceStreamer();
    const started = streamer.start({ apiKey: "test" });
    wsMock.sockets[0].emit("close");

    await expect(started).rejects.toThrow("closed before streaming started");
    expect(streamer.active).toBe(false);
  });
});

describe("PcmVoiceStreamer stop", () => {
  beforeEach(() => {
    wsMock.sockets.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps xAI chunk finals so a later utterance-final send phrase still works", async () => {
    const streamer = new PcmVoiceStreamer(); const events: any[] = [];
    streamer.on("partial", ev => events.push(ev));
    const started = streamer.start({ apiKey: "test" }); const ws = wsMock.sockets[0];
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.created" })), false); await started;
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.partial", start: 0, text: "a long sentence", is_final: true, speech_final: false })), false);
    expect(events.at(-1).speechFinal).toBe(false);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.partial", start: 3, text: "grok send", is_final: true, speech_final: true })), false);
    expect(events.at(-1)).toEqual({ text: "a long sentence grok send", speechFinal: true });
    streamer.cancel();
  });

  it("supports final-only xAI text and marks the whole transcript finalized", async () => {
    const streamer = new PcmVoiceStreamer();
    const started = streamer.start({ apiKey: "test" }); const ws = wsMock.sockets[0];
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.created" })), false); await started;
    const stopped = streamer.stop();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.done", text: "final only" })), false);
    await expect(stopped).resolves.toBe("final only"); expect(streamer.finalizedTranscript).toBe("final only");
  });

  it("cancel settles Stop and rejects late finals from the disposed socket", async () => {
    const streamer = new PcmVoiceStreamer(); const events: any[] = [];
    streamer.on("partial", ev => events.push(ev));
    const started = streamer.start({ apiKey: "test" }); const ws = wsMock.sockets[0];
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.created" })), false); await started;
    const stopped = streamer.stop(); expect(streamer.stop()).toBe(stopped); streamer.cancel();
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.done", text: "late grok send" })), false);
    await expect(stopped).resolves.toBe(""); expect(events).toEqual([]);
  });

  it("waits for transcript.done instead of cutting off a late final result", async () => {
    const streamer = new PcmVoiceStreamer();
    const started = streamer.start({ apiKey: "test" });
    const ws = wsMock.sockets[0];
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.created" })), false);
    await started;

    const stopped = streamer.stop();
    expect(ws.sent).toContain(JSON.stringify({ type: "audio.done" }));
    await vi.advanceTimersByTimeAsync(1000);
    ws.emit("message", Buffer.from(JSON.stringify({
      type: "transcript.partial",
      start: 0,
      text: "the closing words",
      speech_final: true,
    })), false);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.done" })), false);

    await expect(stopped).resolves.toBe("the closing words");
  });

  it("waits for the done belonging to this stop after an earlier smart-turn done", async () => {
    const streamer = new PcmVoiceStreamer();
    const started = streamer.start({ apiKey: "test" });
    const ws = wsMock.sockets[0];
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.created" })), false);
    ws.emit("message", Buffer.from(JSON.stringify({
      type: "transcript.partial",
      start: 0,
      text: "first phrase",
      speech_final: true,
    })), false);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.done" })), false);
    await started;

    ws.emit("message", Buffer.from(JSON.stringify({
      type: "transcript.partial",
      start: 1,
      text: "trailing words",
    })), false);
    const stopped = streamer.stop();
    let settled = false;
    void stopped.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1000);
    expect(settled).toBe(false);

    ws.emit("message", Buffer.from(JSON.stringify({
      type: "transcript.partial",
      start: 1,
      text: "trailing words finalized",
      speech_final: true,
    })), false);
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.done" })), false);

    await expect(stopped).resolves.toBe("first phrase trailing words finalized");
  });

  it("falls back to the accumulated transcript after a bounded terminal wait", async () => {
    const streamer = new PcmVoiceStreamer();
    const started = streamer.start({ apiKey: "test" });
    const ws = wsMock.sockets[0];
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.created" })), false);
    ws.emit("message", Buffer.from(JSON.stringify({
      type: "transcript.partial",
      start: 0,
      text: "best available",
    })), false);
    await started;

    const stopped = streamer.stop();
    await vi.advanceTimersByTimeAsync(5000);

    await expect(stopped).resolves.toBe("best available");
  });
});

describe("VoiceStreamer in-stream failure", () => {
  beforeEach(() => {
    wsMock.sockets.length = 0;
    childMock.processes.length = 0;
    childMock.spawn.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start local capture after cancel during the WebSocket handshake", async () => {
    const streamer = new VoiceStreamer();
    const started = streamer.start({ apiKey: "test", ffmpegPath: "ffmpeg", device: "test mic" });
    const rejected = expect(started).rejects.toThrow("cancelled"); streamer.cancel();
    wsMock.sockets[0].emit("message", Buffer.from(JSON.stringify({ type: "transcript.created" })), false);
    await rejected; await vi.advanceTimersByTimeAsync(8000);
    expect(childMock.spawn).not.toHaveBeenCalled(); expect(streamer.active).toBe(false);
  });

  it("tears down the STT socket and local capture after transcript.created", async () => {
    const streamer = new VoiceStreamer();
    const errors: Error[] = [];
    streamer.on("error", (error: Error) => errors.push(error));
    const started = streamer.start({ apiKey: "test", ffmpegPath: "ffmpeg", device: "test microphone" });
    const ws = wsMock.sockets[0];
    ws.emit("message", Buffer.from(JSON.stringify({ type: "transcript.created" })), false);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(200);
    await started;
    const proc = childMock.processes[0];

    ws.emit("message", Buffer.from(JSON.stringify({
      type: "error",
      message: "protocol stream failed",
    })), false);

    expect(errors.map((error) => error.message)).toEqual(["protocol stream failed"]);
    expect(ws.closed).toBe(true);
    expect(proc.kill).toHaveBeenCalled();
    expect(streamer.active).toBe(false);
  });
});
