/**
 * The live speech-to-text contract shared by the xAI streamer
 * (`voice-streamer.ts`) and the OpenAI adapter (`openai-voice.ts`). Types only,
 * so neither transport has to import the other to agree on it.
 */
import type { EventEmitter } from "node:events";

export interface PcmStreamStartOpts {
  apiKey: string;
  language?: string;
  keyterms?: string[];
  model?: string;
  log?: (msg: string) => void;
}

export interface PartialEvent {
  text: string;
  /** True only if ALL text in this cumulative partial is finalized. */
  speechFinal: boolean;
}

export interface PcmSttStream extends EventEmitter {
  readonly active: boolean;
  readonly transcript: string;
  readonly finalizedTranscript: string;
  start(opts: PcmStreamStartOpts): Promise<void>;
  writePcm(bytes: Uint8Array): boolean;
  stop(): Promise<string>;
  cancel(): void;
}
