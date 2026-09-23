import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type { PcmStreamStartOpts, PcmSttStream, PartialEvent } from "./voice-streamer";

export const OPENAI_STT_MODEL = "gpt-live-transcribe";
export const OPENAI_STT_ENDPOINT = "wss://api.openai.com/v1/realtime?intent=transcription";

/** Vocabulary stays neutral in config; only this adapter knows the model schema. */
export function openAiTranscriptionConfig(opts: PcmStreamStartOpts): Record<string, unknown> {
  const model = opts.model || OPENAI_STT_MODEL;
  const language = opts.language?.trim();
  const terms = (opts.keyterms ?? []).map(t => t.replace(/[<>\r\n]/g, " ").trim()).filter(Boolean);
  if (model === "gpt-live-transcribe") {
    return { model, ...(terms.length ? { keywords: terms } : {}), ...(language ? { languages: [language] } : {}) };
  }
  return {
    model,
    ...(terms.length ? { prompt: model === "whisper-1" ? terms.join(", ") : `Vocabulary: ${terms.join(", ")}.` } : {}),
    ...(language ? { language } : {}),
  };
}

export function classifyOpenAiSttError(status: number): string {
  if (status === 401 || status === 403) return "OpenAI voice transcription was rejected (401/403). Set grok.voiceOpenAiApiKey or OPENAI_API_KEY on the host to an OpenAI API-platform key. Codex / ChatGPT sign-in does not provide transcription API access.";
  if (status === 429) return "OpenAI voice transcription is rate-limited or out of API quota (429). Check your API billing and limits.";
  return `OpenAI voice transcription failed (HTTP ${status}). Try again shortly.`;
}

/** Stateful 3:2 linear interpolation. Carries a split PCM16 sample and the
 * interpolation phase across writes; the producer always supplies 16 kHz LE. */
export class Pcm16To24Khz {
  private byte?: number;
  private previous = 0;
  private samples = 0;
  private next = 0; // source position in thirds of a sample
  private ended = false;

  write(bytes: Uint8Array): Buffer {
    if (this.ended) throw new Error("PCM converter is already finished.");
    const out: number[] = [];
    for (const b of bytes) {
      if (this.byte === undefined) { this.byte = b; continue; }
      const raw = this.byte | (b << 8);
      const sample = raw >= 32768 ? raw - 65536 : raw;
      this.byte = undefined;
      const index = this.samples++;
      while (this.next <= index * 3) {
        const fraction = (this.next - (index - 1) * 3) / 3;
        out.push(index === 0 ? sample : Math.round(this.previous + (sample - this.previous) * fraction));
        this.next += 2;
      }
      this.previous = sample;
    }
    return this.encode(out);
  }

  finish(): Buffer {
    if (this.ended) return Buffer.alloc(0);
    this.ended = true;
    if (this.byte !== undefined) throw new Error("Microphone audio ended in an incomplete PCM16 sample.");
    const out: number[] = [];
    while (this.next < this.samples * 3) { out.push(this.previous); this.next += 2; }
    return this.encode(out);
  }

  private encode(samples: number[]): Buffer {
    const bytes = Buffer.alloc(samples.length * 2);
    samples.forEach((s, i) => bytes.writeInt16LE(s, i * 2));
    return bytes;
  }
}

interface AudioItem {
  previous?: string | null;
  start?: number;
  text: string;
  final: boolean;
  committed: boolean;
}

/** Item identity owns revisions; predecessor links own audio order. Deltas
 * can precede a commit, and completions can precede earlier completions. */
export class OpenAiTranscript {
  private items = new Map<string, AudioItem>();

  apply(ev: any): boolean {
    if (!["input_audio_buffer.speech_started", "input_audio_buffer.committed",
      "conversation.item.input_audio_transcription.delta", "conversation.item.input_audio_transcription.completed"].includes(ev.type)) return false;
    if (typeof ev.item_id !== "string") return false;
    const item = this.items.get(ev.item_id) ?? { text: "", final: false, committed: false };
    this.items.set(ev.item_id, item);
    switch (ev.type) {
      case "input_audio_buffer.speech_started":
        if (typeof ev.audio_start_ms === "number") item.start = ev.audio_start_ms;
        break;
      case "input_audio_buffer.committed":
        item.committed = true;
        if (ev.previous_item_id === null || typeof ev.previous_item_id === "string") item.previous = ev.previous_item_id;
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (item.final || typeof ev.delta !== "string") return false;
        item.text += ev.delta;
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof ev.transcript !== "string") return false;
        item.text = ev.transcript;
        item.final = true;
        break;
      default: return false;
    }
    return true;
  }

  private ordered(): AudioItem[] {
    const result: AudioItem[] = [];
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const item = this.items.get(id);
      if (!item) return;
      if (item.previous) visit(item.previous);
      result.push(item);
    };
    [...this.items.entries()].sort((a, b) => (a[1].start ?? Infinity) - (b[1].start ?? Infinity)).forEach(([id]) => visit(id));
    return result;
  }

  get text(): string { return this.ordered().map(i => i.text).join(" ").replace(/\s+/g, " ").trim(); }
  get complete(): boolean {
    return [...this.items.values()].every(i => i.committed && i.final && i.previous !== undefined
      && (!i.previous || this.items.has(i.previous)));
  }
  get finalizedText(): string {
    return this.complete ? this.text : "";
  }
}

export class OpenAiPcmVoiceStreamer extends EventEmitter implements PcmSttStream {
  private ws?: WebSocket;
  private ready = false;
  private stopping = false;
  private cancelled = false;
  private transcriptState = new OpenAiTranscript();
  private converter = new Pcm16To24Khz();
  private receivedAudio = false;
  private stopPromise?: Promise<string>;
  private resolveStop?: (text: string) => void;
  private rejectStop?: (err: Error) => void;
  private rejectStart?: (err: Error) => void;
  private startTimer?: ReturnType<typeof setTimeout>;
  private stopTimer?: ReturnType<typeof setTimeout>;
  private stopCommitSent = false;
  private stopCommitAcknowledged = false;

  get active(): boolean { return !!this.ws; }
  get transcript(): string { return this.transcriptState.text; }
  get finalizedTranscript(): string { return this.transcriptState.finalizedText; }

  start(opts: PcmStreamStartOpts): Promise<void> {
    if (this.ws || this.stopping) return Promise.reject(new Error("Speech-to-Text stream is already used."));
    opts.log?.("[voice-stream] connect OpenAI Realtime transcription");
    const ws = new WebSocket(OPENAI_STT_ENDPOINT, { headers: { Authorization: `Bearer ${opts.apiKey}` } });
    this.ws = ws;
    return new Promise((resolve, reject) => {
      this.rejectStart = reject;
      this.startTimer = setTimeout(() => this.fail(new Error("OpenAI Speech-to-Text streaming did not start (timeout). Check your network and API key.")), 8000);
      ws.on("open", () => {
        if (this.ws !== ws) return;
        this.send({ type: "session.update", session: { type: "transcription", audio: { input: {
          format: { type: "audio/pcm", rate: 24000 },
          transcription: openAiTranscriptionConfig(opts),
          turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        } } } });
      });
      ws.on("message", (data: WebSocket.RawData, binary: boolean) => {
        if (this.ws !== ws || binary) return;
        let ev: any;
        try { ev = JSON.parse(data.toString()); } catch { return; }
        if (ev.type === "session.updated") {
          if (!this.ready) {
            this.ready = true;
            clearTimeout(this.startTimer);
            this.rejectStart = undefined;
            resolve();
          } else if (this.stopping && !this.stopCommitSent) {
            // This acknowledgement is a barrier after disabling VAD. An earlier
            // automatic commit cannot race the final append/commit pair.
            this.stopCommitSent = true;
            try {
              this.append(this.converter.finish());
              // Realtime requires >=100 ms per commit, including a very short
              // tail after VAD. Silence also makes Stop safe on an empty buffer.
              this.append(Buffer.alloc(4800));
              this.send({ type: "input_audio_buffer.commit", event_id: "voice-stop-commit" });
            } catch (err) { this.fail(err as Error); }
          }
        } else if (ev.type === "error" || ev.type === "conversation.item.input_audio_transcription.failed") {
          if (this.stopCommitSent && ev.error?.event_id === "voice-stop-commit" && ev.error?.code === "input_audio_buffer_commit_empty") {
            this.stopCommitAcknowledged = true;
            this.maybeFinish();
          } else {
            this.fail(new Error(`OpenAI voice transcription: ${ev.error?.message || "stream failed"}`));
          }
        } else if (this.transcriptState.apply(ev)) {
          if (ev.type === "input_audio_buffer.committed" && this.stopCommitSent) this.stopCommitAcknowledged = true;
          this.emit("partial", { text: this.transcript, speechFinal: this.transcriptState.complete } as PartialEvent);
          this.maybeFinish();
        }
      });
      ws.on("unexpected-response", (_req, res) => this.ws === ws && this.fail(new Error(classifyOpenAiSttError(res.statusCode || 0))));
      ws.on("error", (err) => { if (this.ws === ws) this.fail(err); });
      ws.on("close", () => {
        if (this.ws !== ws) return;
        if (!this.ready || this.stopping) this.fail(new Error("OpenAI Speech-to-Text connection closed before transcription finished."));
        else {
          this.dispose();
          this.emit("ended");
        }
      });
    });
  }

  private send(event: unknown): boolean {
    try { this.ws!.send(JSON.stringify(event)); return true; }
    catch (err) { this.fail(err as Error); return false; }
  }

  private append(bytes: Buffer): boolean {
    return !bytes.length || this.send({ type: "input_audio_buffer.append", audio: bytes.toString("base64") });
  }

  writePcm(bytes: Uint8Array): boolean {
    if (!this.ready || !this.ws || this.ws.readyState !== WebSocket.OPEN || this.stopping || !bytes.byteLength) return false;
    this.receivedAudio = true;
    return this.append(this.converter.write(bytes));
  }

  stop(): Promise<string> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (!this.ready || !this.receivedAudio) {
      this.cancel();
      return this.stopPromise = Promise.resolve("");
    }
    if (!this.ws) return Promise.reject(new Error("OpenAI Speech-to-Text connection is closed."));
    this.stopPromise = new Promise((resolve, reject) => { this.resolveStop = resolve; this.rejectStop = reject; });
    this.stopTimer = setTimeout(() => this.fail(new Error("OpenAI voice transcription timed out while finalizing the recording.")), 8000);
    this.send({ type: "session.update", session: { type: "transcription", audio: { input: { turn_detection: null } } } });
    return this.stopPromise;
  }

  private maybeFinish(): void {
    if (!this.stopping || !this.stopCommitAcknowledged || !this.transcriptState.complete) return;
    this.resolveStop?.(this.transcript);
    this.resolveStop = this.rejectStop = undefined;
    this.dispose();
  }

  cancel(): void {
    this.cancelled = true;
    this.stopping = true;
    this.rejectStart?.(new Error("Voice recording cancelled."));
    this.rejectStart = undefined;
    this.resolveStop?.("");
    this.resolveStop = this.rejectStop = undefined;
    this.dispose();
  }

  private fail(err: Error): void {
    if (this.cancelled || !this.ws) return;
    const starting = this.rejectStart;
    const stopping = this.rejectStop;
    this.rejectStart = this.rejectStop = undefined;
    this.resolveStop = undefined;
    this.dispose();
    if (starting) starting(err);
    else if (stopping) stopping(err);
    else this.emit("error", err);
  }

  private dispose(): void {
    clearTimeout(this.startTimer);
    clearTimeout(this.stopTimer);
    const ws = this.ws;
    this.ws = undefined;
    try { ws?.close(); } catch { /* already closed */ }
  }
}
