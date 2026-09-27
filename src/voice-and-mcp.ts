import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { Uri } from "./host";
import type { Session, SessionStartIntent } from "./session";
import type { CompanionsSkipReason } from "./companion-subagents";
import type { AcpProvider } from "./acp-backend";
import {
  type HostMsg,
} from "./protocol";
import {
  MCP_GLOBAL_SCOPE_WARNING,
  mergeMcpNotification,
  parseMcpListResponse,
  mcpSettingsServersForCwd,
  type McpServerView,
} from "./mcp";
import {
  MCP_CONNECTORS_KEY,
  MAX_CONNECTOR_KEY_CHARS,
  TIER1_CONNECTORS,
  bearerAuthorizationHeader,
  collectMcpNameFiles,
  collectMcpNameLayers,
  collectReservedMcpIdentity,
  connectConnector,
  connectorById,
  connectorViews,
  disconnectConnector,
  hostMcpServers,
  isConnectorId,
  isKeyConnector,
  mcpConfigLayer,
  mcpConfigPaths,
  mcpConnectorSecretKey,
  mcpRemoteArgs,
  mergeReserved,
  parseConnectedConnectorStore,
  reservedFromMcpInventory,
  withAuthHeaderEnv,
  type ConnectedConnectorStore,
  type ConnectorDef,
  type ConnectorId,
  type ReservedMcpIdentity,
} from "./mcp-connectors";
import {
  authorizeMcpRemote,
  connectorsLackingOAuthToken,
  npxSpawnPlan,
  persistConnectorOAuthClientMetadata,
  writeOAuthClientMetadataFile,
} from "./mcp-connector-auth";
import {
  DEFAULT_SEND_PHRASE,
  type SttBackend,
  buildSttKeyterms,
  parseFinalVoiceCommand,
  parseVoiceCommand,
  sanitizeVoiceKeyterms,
  voiceConfiguredFingerprint,
  voiceSettingForRepo,
} from "./voice";
import { OPENAI_STT_MODEL } from "./openai-voice";
import {
  VoiceRecorder,
  transcribeAudio,
  resolveWindowsAudioDevice,
} from "./voice-recorder";
import { VoiceStreamer } from "./voice-streamer";
import {
  describeFfmpegProblem,
  ffmpegInstallHint,
  resolveConfiguredFfmpeg,
  type FfmpegResolution,
} from "./ffmpeg-locate";
import {
  base64DecodedByteLength,
  isTrustedCodexGeneratedImagePath,
  isTrustedGeneratedMediaPath,
  MAX_INLINE_MEDIA_BYTES,
} from "./media-serve";
import {
  fileUriToPath,
  shouldReadFileInline,
} from "./file-ref";
import {
  isVisionImagePath,
  makeExplicitChip,
} from "./chips";
import { resolveGrokHome, normalizeRepoPath } from "./sessions";
import { resolveCodexHome } from "./codex-cli-locator";
import { pathsEqual } from "./worktree";
import { normalizeRelPath } from "./mention";
import { errorDetail, type MediaRef } from "./acp-dispatch";

export type AttachmentOwner = () => Session | undefined;

export interface MementoLike {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: any): Thenable<void> | Promise<void>;
}

export interface VoiceStreamContext {
  key: string;
  backend: SttBackend;
  model: string;
  ffmpegPath: string;
  device?: string;
  phrase: string;
  keyterms: string[];
  language?: string;
  generation: number;
}

export interface VoiceAndMcpHostOps {
  appendLine(line: string): void;
  showInformationMessage(message: string, ...items: string[]): Thenable<string | undefined> | Promise<string | undefined>;
  showErrorMessage(message: string, ...items: string[]): Thenable<string | undefined> | Promise<string | undefined>;
  showWarningMessage(message: string, ...items: string[]): Thenable<string | undefined> | Promise<string | undefined>;
  showSaveDialog(options: any): Thenable<any> | Promise<any>;
  showQuickPick(items: any[], options?: any): Thenable<any> | Promise<any>;
  openExternal(target: string | Uri): Thenable<boolean> | Promise<boolean>;
  openSettings(query?: string): Thenable<void> | Promise<void>;
  createTerminal(name: string): any;
  getConfiguration(section?: string, scope?: any): any;
  isInWorkspace(fsPath: string): boolean;
  canOpenSettingsEditor?: boolean;
  openHostResolvedPath?(file: string): Thenable<void> | Promise<void>;
  fs: { readFile(uri: Uri): Promise<Uint8Array> };
}

export interface VoiceAndMcpVoiceOps {
  sessionCwd(session?: Session): string;
  workspaceRoot(): string;
  defaultProviderForProject(cwd: string): AcpProvider;
  resolveSttApiKey(cwd: string, backend: SttBackend): string | undefined;
  voiceBackendState(cwd: string, provider: AcpProvider): any;
  openSettingsEditor?(tab?: string): Promise<void>;
  postLocal(msg: HostMsg): void;
  post(msg: HostMsg): void;
}

export interface VoiceAndMcpMcpOps {
  connectedProviders(): AcpProvider[];
  newLocalSession(): Session;
  setSessionCwd(session: Session, cwd: string, root?: string): void;
  startSession(id?: string, target?: Session, mode?: SessionStartIntent): Promise<any>;
  askUserMcpServer(session: Session): Promise<any>;
  companionsMcpServer(session: Session): Promise<any>;
  noteCompanionsSkip(session: Session, reason: CompanionsSkipReason): void;
  postWelcomeTips(): void;
  getSettingsWebview(): { postMessage(msg: any): Thenable<boolean> | Promise<boolean> } | undefined;
}

export interface VoiceAndMcpMediaOps {
  emit(session: Session, msg: HostMsg): void;
  getViewWebview(): { asWebviewUri(uri: Uri): any; postMessage(msg: any): Thenable<boolean> | Promise<boolean> } | undefined;
  isImagePathAuthorizedNow(path: string, session: Session): boolean;
  registerFullImage(path: string): string;
  importImageFromDisk(path: string, owner: any): Promise<Session | false | undefined>;
  postChips(session: Session): void;
}

export interface VoiceAndMcpDeps {
  host: VoiceAndMcpHostOps;
  state: MementoLike;
  context: {
    secrets: {
      get(key: string): Thenable<string | undefined> | Promise<string | undefined>;
      store(key: string, value: string): Thenable<void> | Promise<void>;
      delete(key: string): Thenable<void> | Promise<void>;
    };
    globalStorageUri: { fsPath: string };
  };
  getFocused: () => Session;
  getPool: () => Iterable<Session>;
  getOverride?: (name: string) => any;
  voiceOps: VoiceAndMcpVoiceOps;
  mcpOps: VoiceAndMcpMcpOps;
  mediaOps: VoiceAndMcpMediaOps;
}

function statKindSafe(p: string): "file" | "dir" | "none" {
  try {
    const s = fs.statSync(p);
    return s.isFile() ? "file" : s.isDirectory() ? "dir" : "none";
  } catch {
    return "none";
  }
}

function guessMediaMime(p: string): string {
  const ext = p.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "bmp": return "image/bmp";
    case "svg": return "image/svg+xml";
    case "mp4":
    case "m4v": return "video/mp4";
    case "mov": return "video/quicktime";
    default: return "application/octet-stream";
  }
}

export class VoiceAndMcp {
  // ── Voice State ──────────────────────────────────────────────────────────
  public voiceRecorder: any = new VoiceRecorder();
  public voiceGeneration = 0;
  public voiceStreamer: VoiceStreamer | undefined;
  public voiceStoppingStreamer: VoiceStreamer | undefined;
  public voiceStreamCtx?: VoiceStreamContext;
  public voiceBatchCtx?: { backend: SttBackend; key: string };
  public voiceTempPath?: string;
  public voiceFinalizing = false;
  public localVoiceCwd?: string;
  public localVoiceCredentialCwd?: string;
  public lastVoiceConfiguredByCwd = new Map<string, boolean>();
  public lastPostedVoiceConfigured = new Map<string, string>();

  // ── MCP State ────────────────────────────────────────────────────────────
  public mcpServers: McpServerView[] = [];
  public mcpServersCwd?: string;
  public mcpServersView: McpServerView[] = [];
  public mcpListSupported?: boolean;
  public mcpConnectingId?: ConnectorId;
  public mcpConnectError?: { id: ConnectorId; message: string };
  public mcpConnectorKeys = new Map<ConnectorId, string>();
  public grokMcpReserved: ReservedMcpIdentity = { names: [], urls: [] };
  public grokSessionForMcpListInFlight?: Promise<Session | undefined>;

  constructor(public deps: VoiceAndMcpDeps) {}

  // ── Voice Subsystem ──────────────────────────────────────────────────────

  public rememberVoiceConfigured(cwd: string, value: boolean): void {
    const override = this.deps.getOverride?.("rememberVoiceConfigured");
    if (override) return override(cwd, value);
    this.lastVoiceConfiguredByCwd.set(normalizeRepoPath(cwd), value);
  }

  public voiceConfiguredMsg(
    cwd: string,
    value: boolean,
    provider: AcpProvider = this.deps.getFocused().provider,
  ): Extract<HostMsg, { type: "voiceConfigured" }> {
    const override = this.deps.getOverride?.("voiceConfiguredMsg");
    if (override) return override(cwd, value, provider);
    return {
      type: "voiceConfigured",
      value,
      sendPhrase: this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE),
      keyterms: sanitizeVoiceKeyterms(this.voiceSetting(cwd, "voiceKeyterms", [])),
      backendState: this.deps.voiceOps.voiceBackendState(cwd, provider),
    };
  }

  public seedPostedVoiceConfigured(
    destKey: string,
    payload: Extract<HostMsg, { type: "voiceConfigured" }>,
  ): void {
    const override = this.deps.getOverride?.("seedPostedVoiceConfigured");
    if (override) return override(destKey, payload);
    this.lastPostedVoiceConfigured.set(destKey, voiceConfiguredFingerprint(payload));
  }

  public forgetPostedVoiceConfigured(destKey: string): void {
    const override = this.deps.getOverride?.("forgetPostedVoiceConfigured");
    if (override) return override(destKey);
    this.lastPostedVoiceConfigured.delete(destKey);
  }

  public deliverVoiceConfigured(
    destKey: string,
    payload: Extract<HostMsg, { type: "voiceConfigured" }>,
    send: () => void,
  ): boolean {
    const override = this.deps.getOverride?.("deliverVoiceConfigured");
    if (override) return override(destKey, payload, send);
    const fp = voiceConfiguredFingerprint(payload);
    if (this.lastPostedVoiceConfigured.get(destKey) === fp) return false;
    this.seedPostedVoiceConfigured(destKey, payload);
    send();
    return true;
  }

  public postVoiceConfigured(): void {
    const override = this.deps.getOverride?.("postVoiceConfigured");
    if (override) return override();
    const focused = this.deps.getFocused();
    const cwd = this.deps.voiceOps.sessionCwd(focused);
    const configured = !!this.deps.voiceOps.voiceBackendState(cwd, focused.provider).backend;
    const localMsg = this.voiceConfiguredMsg(cwd, configured, focused.provider);
    this.lastVoiceConfiguredByCwd.clear();
    this.rememberVoiceConfigured(cwd, configured);
    this.deliverVoiceConfigured("local", localMsg, () => {
      this.deps.voiceOps.postLocal(localMsg);
      void this.deps.mcpOps.getSettingsWebview()?.postMessage(localMsg);
    });
  }

  public voiceSetting<T = any>(cwd: string, key: string, fallback: T): T {
    const override = this.deps.getOverride?.("voiceSetting");
    if (override) return override(cwd, key, fallback);
    const cfg = this.deps.host.getConfiguration("grok", cwd);
    return voiceSettingForRepo(
      cfg?.get(key),
      cfg?.inspect(key),
      this.deps.host.isInWorkspace(cwd),
      fallback,
    );
  }

  public async promptVoiceKeySetup(): Promise<void> {
    const override = this.deps.getOverride?.("promptVoiceKeySetup");
    if (override) return override();
    const pick = await this.deps.host.showInformationMessage(
      "Voice needs a credential for the selected backend. Set an OpenAI API key (grok.voiceOpenAiApiKey / OPENAI_API_KEY), or use an xAI key / Grok sign-in. Codex and ChatGPT sign-in do not include transcription API access.",
      "Open Settings",
      "Get a Key",
    );
    if (pick === "Open Settings") {
      if (this.deps.host.canOpenSettingsEditor && this.deps.voiceOps.openSettingsEditor) {
        await this.deps.voiceOps.openSettingsEditor("voice");
      } else {
        await this.deps.host.openSettings("grok.voice");
      }
    } else if (pick === "Get a Key") {
      await this.deps.host.openExternal("https://platform.openai.com/api-keys");
    }
  }

  public rejectVoiceStart(): void {
    const override = this.deps.getOverride?.("rejectVoiceStart");
    if (override) return override();
    this.deps.voiceOps.postLocal({ type: "voiceError" });
    void this.deps.host.showWarningMessage("Voice control is already active.");
  }

  public claimVoice(cwd: string): boolean {
    const override = this.deps.getOverride?.("claimVoice");
    if (override) return override(cwd);
    if (this.localVoiceCwd) return false;
    this.localVoiceCwd = cwd;
    return true;
  }

  public releaseVoice(cwd?: string): void {
    const override = this.deps.getOverride?.("releaseVoice");
    if (override) return override(cwd);
    if (!cwd || cwd === this.localVoiceCwd) this.localVoiceCwd = undefined;
  }

  public async reportFfmpegProblem(problem: Extract<FfmpegResolution, { ok: false }>): Promise<void> {
    const override = this.deps.getOverride?.("reportFfmpegProblem");
    if (override) return override(problem);
    const hasBrew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].some(
      (p) => statKindSafe(p) === "file",
    );
    const hint = problem.reason === "not-installed" ? ffmpegInstallHint(process.platform, hasBrew) : undefined;
    const message = describeFfmpegProblem(problem, hint);
    this.deps.host.appendLine(`[voice] ${message}`);
    const actions = hint?.offerToRun ? ["Install ffmpeg", "Open Settings"] : ["Open Settings"];
    const pick = await this.deps.host.showErrorMessage(message, ...actions);
    if (pick === "Install ffmpeg" && hint) {
      const term = this.deps.host.createTerminal("Install ffmpeg");
      term.sendText(hint.command, false);
      term.show();
      return;
    }
    if (pick === "Open Settings") await this.deps.host.openSettings("grok.ffmpegPath");
  }

  public async handleVoiceStart(session: Session = this.deps.getFocused()): Promise<void> {
    const override = this.deps.getOverride?.("handleVoiceStart");
    if (override) return override(session);
    const cwd = this.deps.voiceOps.sessionCwd(session);
    const credentialCwd = this.deps.voiceOps.sessionCwd(session);
    const backend = this.deps.voiceOps.voiceBackendState(credentialCwd, session.provider).backend;
    const key = backend && (this.deps.getOverride?.("resolveSttApiKey") ?? this.deps.voiceOps.resolveSttApiKey)(credentialCwd, backend);
    if (!key || !backend) {
      void this.promptVoiceKeySetup();
      this.deps.voiceOps.postLocal({ type: "voiceError" });
      return;
    }
    if (!this.claimVoice(cwd)) {
      this.rejectVoiceStart();
      return;
    }
    const generation = ++this.voiceGeneration;
    this.localVoiceCredentialCwd = credentialCwd;
    const cfg = this.deps.host.getConfiguration("grok");
    const resolvedFfmpeg = resolveConfiguredFfmpeg(cfg?.get("ffmpegPath", "") ?? "", {
      platform: process.platform,
      pathEnv: process.env.PATH,
      isFile: (p) => statKindSafe(p) === "file",
      isDirectory: (p) => statKindSafe(p) === "dir",
    });
    if (!resolvedFfmpeg.ok) {
      void this.reportFfmpegProblem(resolvedFfmpeg as Extract<FfmpegResolution, { ok: false }>);
      this.releaseVoice(cwd);
      this.localVoiceCredentialCwd = undefined;
      this.deps.voiceOps.postLocal({ type: "voiceError" });
      return;
    }
    const ffmpegPath = resolvedFfmpeg.path;
    const device = cfg?.get("voiceInputDevice", "") || undefined;

    if (cfg?.get("voiceStreaming", true) ?? true) {
      await this.startVoiceStream(key, ffmpegPath, device, cwd, generation, backend);
      return;
    }

    this.voiceBatchCtx = { backend, key };
    const tmp = path.join(os.tmpdir(), `grok-voice-${Date.now()}.wav`);
    try {
      await this.voiceRecorder.start({ ffmpegPath, outputPath: tmp, device, log: (m: string) => this.deps.host.appendLine(m) });
      if (generation !== this.voiceGeneration) {
        this.voiceRecorder.cancel();
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        return;
      }
      this.voiceTempPath = tmp;
      this.deps.voiceOps.postLocal({ type: "voiceState", status: "listening" });
    } catch (e) {
      if (generation !== this.voiceGeneration) {
        try { fs.unlinkSync(tmp); } catch { /* best effort */ }
        return;
      }
      const msg = (e as Error).message;
      this.deps.host.appendLine(`[voice] start failed: ${msg}`);
      if (/ffmpeg/i.test(msg)) {
        const pick = await this.deps.host.showErrorMessage(msg, "Open Settings");
        if (pick === "Open Settings") {
          await this.deps.host.openSettings("grok.ffmpegPath");
        }
      } else {
        void this.deps.host.showErrorMessage(msg);
      }
      this.releaseVoice(cwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      this.deps.voiceOps.postLocal({ type: "voiceError" });
    }
  }

  public async startVoiceStream(
    key: string,
    ffmpegPath: string,
    device: string | undefined,
    cwd: string,
    generation: number,
    backend: SttBackend,
  ): Promise<void> {
    const override = this.deps.getOverride?.("startVoiceStream");
    if (override) return override(key, ffmpegPath, device, cwd, generation, backend);
    const phrase = this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE);
    const keyterms = buildSttKeyterms(
      phrase,
      this.voiceSetting(cwd, "voiceKeyterms", []),
    );
    const language = this.voiceSetting(cwd, "voiceLanguage", "").trim() || undefined;
    let resolved = device;
    if (process.platform === "win32" && !resolved) {
      try { resolved = await resolveWindowsAudioDevice(ffmpegPath, (m: string) => this.deps.host.appendLine(m)); } catch { /* streamer surfaces it */ }
    }
    if (generation !== this.voiceGeneration) return;
    const model = this.voiceSetting(cwd, "voiceOpenAiModel", OPENAI_STT_MODEL);
    this.voiceStreamCtx = { key, backend, model, ffmpegPath, device: resolved, phrase, keyterms, language, generation };
    this.voiceFinalizing = false;
    await this.openVoiceStream();
  }

  public async openVoiceStream(): Promise<void> {
    const override = this.deps.getOverride?.("openVoiceStream");
    if (override) return override();
    const ctx = this.voiceStreamCtx;
    if (!ctx) return;
    const cwd = this.localVoiceCredentialCwd ?? this.deps.voiceOps.workspaceRoot();
    const fresh = (this.deps.getOverride?.("resolveSttApiKey") ?? this.deps.voiceOps.resolveSttApiKey)(cwd, ctx.backend);
    if (fresh) ctx.key = fresh;
    const streamer = new VoiceStreamer();
    this.voiceStreamer = streamer;
    const isCurrent = () =>
      this.voiceStreamer === streamer && ctx.generation === this.voiceGeneration;

    streamer.on("partial", (ev: { text: string; speechFinal: boolean }) => {
      if (!isCurrent()) return;
      this.deps.voiceOps.postLocal({ type: "voicePartial", text: ev.text });
      if (ev.speechFinal && ctx.phrase) {
        const parsed = parseVoiceCommand(ev.text, ctx.phrase);
        if (parsed.send) this.commitVoiceStream(parsed.text);
      }
    });
    streamer.on("ended", () => {
      if (isCurrent()) void this.finalizeVoiceStream();
    });
    streamer.on("error", (e: Error) => {
      if (!isCurrent()) return;
      streamer.cancel();
      this.deps.host.appendLine(`[voice] stream error: ${e.message}`);
      if (!this.voiceFinalizing) {
        if (/\b(401|403)\b|rejected/i.test(e.message)) {
          void this.deps.host.showErrorMessage(e.message, "Open Settings").then((pick) => {
            if (pick === "Open Settings") void this.deps.host.openSettings(ctx.backend === "openai" ? "grok.voiceOpenAiApiKey" : "grok.voiceApiKey");
          });
        } else {
          void this.deps.host.showErrorMessage(`Voice transcription failed: ${e.message}`);
        }
        this.deps.voiceOps.postLocal({ type: "voiceError" });
      }
      this.voiceStreamer = undefined;
      this.voiceStreamCtx = undefined;
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
    });

    try {
      await streamer.start({
        ffmpegPath: ctx.ffmpegPath,
        apiKey: ctx.key,
        backend: ctx.backend,
        model: ctx.model,
        device: ctx.device,
        keyterms: ctx.keyterms,
        language: ctx.language,
        log: (m: string) => this.deps.host.appendLine(m),
      });
      if (!isCurrent()) { streamer.cancel(); return; }
      this.deps.voiceOps.postLocal({ type: "voiceState", status: "listening" });
    } catch (e) {
      if (!isCurrent()) return;
      this.voiceStreamer = undefined;
      this.voiceStreamCtx = undefined;
      const msg = (e as Error).message;
      this.deps.host.appendLine(`[voice] stream start failed: ${msg}`);
      if (/ffmpeg/i.test(msg)) {
        const pick = await this.deps.host.showErrorMessage(msg, "Open Settings");
        if (pick === "Open Settings") {
          await this.deps.host.openSettings("grok.ffmpegPath");
        }
      } else if (/\b(401|403)\b|rejected/i.test(msg)) {
        const pick = await this.deps.host.showErrorMessage(msg, "Open Settings");
        if (pick === "Open Settings") {
          await this.deps.host.openSettings(ctx.backend === "openai" ? "grok.voiceOpenAiApiKey" : "grok.voiceApiKey");
        }
      } else {
        void this.deps.host.showErrorMessage(msg);
      }
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      this.deps.voiceOps.postLocal({ type: "voiceError" });
    }
  }

  public commitVoiceStream(text: string): void {
    const override = this.deps.getOverride?.("commitVoiceStream");
    if (override) return override(text);
    const ctx = this.voiceStreamCtx;
    if (!ctx || ctx.generation !== this.voiceGeneration) return;
    const old = this.voiceStreamer;
    this.voiceStreamer = undefined;
    old?.cancel();
    this.deps.voiceOps.postLocal({ type: "voiceSubmit", text: text.trim() });
    void this.openVoiceStream();
  }

  public async finalizeVoiceStream(): Promise<void> {
    const override = this.deps.getOverride?.("finalizeVoiceStream");
    if (override) return override();
    if (this.voiceFinalizing) return;
    const generation = this.voiceGeneration;
    this.voiceFinalizing = true;
    const streamer = this.voiceStreamer;
    this.voiceStreamer = undefined;
    const ctx = this.voiceStreamCtx;
    this.voiceStreamCtx = undefined;
    if (!streamer) { this.voiceFinalizing = false; return; }
    this.voiceStoppingStreamer = streamer;
    this.deps.voiceOps.postLocal({ type: "voiceState", status: "transcribing" });
    let finalText = "";
    let completed = true;
    try { finalText = await streamer.stop(); } catch (err) {
      completed = false;
      finalText = streamer.transcript;
      if (generation === this.voiceGeneration) void this.deps.host.showErrorMessage((err as Error).message);
    }
    if (this.voiceStoppingStreamer === streamer) this.voiceStoppingStreamer = undefined;
    if (generation !== this.voiceGeneration) {
      this.voiceFinalizing = false;
      return;
    }
    const cwd = this.localVoiceCredentialCwd ?? this.deps.voiceOps.workspaceRoot();
    const phrase = ctx?.phrase ?? this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE);
    const { text, send } = parseFinalVoiceCommand(finalText, completed ? streamer.finalizedTranscript : "", phrase);
    this.voiceFinalizing = false;
    this.releaseVoice(this.localVoiceCwd);
    this.localVoiceCwd = undefined;
    this.localVoiceCredentialCwd = undefined;
    if (!text && !send) {
      this.deps.voiceOps.postLocal({ type: "voiceError" });
      return;
    }
    this.deps.voiceOps.postLocal({ type: "voiceTranscript", text, send });
  }

  public stopVoiceInput(session?: Session): void {
    const override = this.deps.getOverride?.("stopVoiceInput");
    if (override) return override(session);
    if (!session || session === this.deps.getFocused()) {
      const wasActive =
        !!this.localVoiceCwd ||
        !!this.voiceStreamer ||
        !!this.voiceStreamCtx ||
        this.voiceRecorder.active ||
        this.voiceFinalizing ||
        !!this.voiceTempPath;
      this.voiceGeneration += 1;
      this.voiceStreamer?.cancel();
      this.voiceStoppingStreamer?.cancel();
      this.voiceStoppingStreamer = undefined;
      this.voiceStreamer = undefined;
      this.voiceStreamCtx = undefined;
      this.voiceFinalizing = false;
      this.voiceRecorder.cancel();
      try { if (this.voiceTempPath) fs.unlinkSync(this.voiceTempPath); } catch { /* best effort */ }
      this.voiceTempPath = undefined;
      this.voiceBatchCtx = undefined;
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      if (wasActive) this.deps.voiceOps.postLocal({ type: "voiceState", status: "idle" });
    }
  }

  public async handleVoiceStop(): Promise<void> {
    const override = this.deps.getOverride?.("handleVoiceStop");
    if (override) return override();
    const generation = this.voiceGeneration;
    if (this.voiceStreamer) {
      await this.finalizeVoiceStream();
      return;
    }
    if (!this.voiceRecorder.active) {
      if (this.localVoiceCwd) this.stopVoiceInput();
      this.deps.voiceOps.postLocal({ type: "voiceError" });
      return;
    }
    const cwd = this.localVoiceCredentialCwd ?? this.deps.voiceOps.workspaceRoot();
    const batch = this.voiceBatchCtx;
    const key = batch && ((this.deps.getOverride?.("resolveSttApiKey") ?? this.deps.voiceOps.resolveSttApiKey)(cwd, batch.backend) || batch.key);
    if (!key) {
      this.voiceRecorder.cancel();
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      this.deps.voiceOps.postLocal({ type: "voiceError" });
      return;
    }
    let wavPath: string;
    try {
      wavPath = await this.voiceRecorder.stop();
      if (generation !== this.voiceGeneration) {
        try { fs.unlinkSync(wavPath); } catch { /* best effort */ }
        return;
      }
    } catch (e) {
      if (generation !== this.voiceGeneration) return;
      this.deps.host.appendLine(`[voice] stop failed: ${(e as Error).message}`);
      void this.deps.host.showErrorMessage(`Voice recording failed: ${(e as Error).message}`);
      this.releaseVoice(this.localVoiceCwd);
      this.localVoiceCwd = undefined;
      this.localVoiceCredentialCwd = undefined;
      this.deps.voiceOps.postLocal({ type: "voiceError" });
      return;
    }
    const tempPath = this.voiceTempPath;
    this.deps.voiceOps.postLocal({ type: "voiceState", status: "transcribing" });
    try {
      const raw = await transcribeAudio(wavPath, key, (m: string) => this.deps.host.appendLine(m), batch?.backend);
      if (generation !== this.voiceGeneration) return;
      const sendPhrase = this.voiceSetting(cwd, "voiceSendPhrase", DEFAULT_SEND_PHRASE);
      const { text, send } = parseVoiceCommand(raw, sendPhrase);
      if (!text && !send) {
        void this.deps.host.showInformationMessage("Voice control: nothing was transcribed (silence?).");
        this.deps.voiceOps.postLocal({ type: "voiceError" });
        return;
      }
      this.deps.voiceOps.postLocal({ type: "voiceTranscript", text, send });
    } catch (e) {
      if (generation !== this.voiceGeneration) return;
      this.deps.host.appendLine(`[voice] transcription failed: ${(e as Error).message}`);
      void this.deps.host.showErrorMessage((e as Error).message);
      this.deps.voiceOps.postLocal({ type: "voiceError" });
    } finally {
      try { if (tempPath) fs.unlinkSync(tempPath); } catch { /* best effort */ }
      if (this.voiceTempPath === tempPath) this.voiceTempPath = undefined;
      if (this.voiceBatchCtx === batch) {
        this.voiceBatchCtx = undefined;
        this.releaseVoice(this.localVoiceCwd);
        this.localVoiceCwd = undefined;
        this.localVoiceCredentialCwd = undefined;
      }
    }
  }

  // ── MCP Subsystem ────────────────────────────────────────────────────────

  public applyMcpNotification(session: Session, method: string, params: unknown): void {
    const override = this.deps.getOverride?.("applyMcpNotification");
    if (override) return override(session, method, params);
    if (this.mcpListSupported === false) return;
    const next = mergeMcpNotification(this.mcpServers, method, params);
    this.grokMcpReserved = reservedFromMcpInventory(next, this.connectedConnectorStore());
    if (this.mcpServersCwd && !pathsEqual(this.deps.voiceOps.sessionCwd(session), this.mcpServersCwd)) return;
    this.mcpServers = next;
    this.mcpServersView = this.filterMcpServers(this.mcpServers);
    if (this.mcpListSupported === true) {
      this.postMcpServers({
        type: "mcpServers",
        servers: this.mcpServersView,
        warning: MCP_GLOBAL_SCOPE_WARNING,
      });
    }
  }

  public postMcpServers(message: Extract<HostMsg, { type: "mcpServers" }>): void {
    const override = this.deps.getOverride?.("postMcpServers");
    if (override) return override(message);
    const view = {
      ...message,
      servers: this.mcpServersView,
    };
    this.deps.voiceOps.post(view);
    void this.deps.mcpOps.getSettingsWebview()?.postMessage(view);
  }

  public connectedConnectorStore(): ConnectedConnectorStore {
    const override = this.deps.getOverride?.("connectedConnectorStore");
    if (override) return override();
    return parseConnectedConnectorStore(this.deps.state.get(MCP_CONNECTORS_KEY, {}));
  }

  public mcpConnectorsMessage(): Extract<HostMsg, { type: "mcpConnectors" }> {
    const override = this.deps.getOverride?.("mcpConnectorsMessage");
    if (override) return override();
    const store = this.connectedConnectorStore();
    return {
      type: "mcpConnectors",
      connectors: connectorViews(store, {
        connectingId: this.mcpConnectingId,
        errorId: this.mcpConnectError?.id,
        error: this.mcpConnectError?.message,
        keySet: new Set((this.mcpConnectorKeys ?? new Map()).keys()),
        lapsed: this.lapsedOAuthConnectors(store),
      }),
    };
  }

  public postMcpConnectors(): void {
    const override = this.deps.getOverride?.("postMcpConnectors");
    if (override) return override();
    const message = this.mcpConnectorsMessage();
    this.deps.voiceOps.post(message);
    void this.deps.mcpOps.getSettingsWebview()?.postMessage(message);
    this.deps.mcpOps.postWelcomeTips();
  }

  public mcpNameCatalogFor(cwd: string): {
    nameLayer: Map<string, "project" | "user">;
    nameFile: Map<string, string>;
  } {
    const override = this.deps.getOverride?.("mcpNameCatalogFor");
    if (override) return override(cwd);
    const opts = {
      cwd,
      provider: "grok" as const,
      grokHome: resolveGrokHome(process.env),
      userHome: process.env.USERPROFILE || process.env.HOME || os.homedir(),
    };
    const files: { layer: "project" | "user"; path: string; names: string[] }[] = [];
    for (const filePath of mcpConfigPaths(opts)) {
      try {
        if (!fs.existsSync(filePath)) continue;
        files.push({
          layer: mcpConfigLayer(filePath, opts),
          path: filePath,
          names: collectReservedMcpIdentity(fs.readFileSync(filePath, "utf8")).names,
        });
      } catch {
        // Unreadable configs must not block the inventory page.
      }
    }
    return {
      nameLayer: collectMcpNameLayers(files),
      nameFile: collectMcpNameFiles(files),
    };
  }

  public filterMcpServers(servers: readonly McpServerView[] = this.mcpServers): McpServerView[] {
    const override = this.deps.getOverride?.("filterMcpServers");
    if (override) return override(servers);
    return mcpSettingsServersForCwd({
      servers,
      catalogCwd: this.mcpServersCwd,
      nameCatalogFor: (cwd) => this.mcpNameCatalogFor(cwd),
    });
  }

  public reservedMcpIdentityFor(session: Session): ReservedMcpIdentity {
    const override = this.deps.getOverride?.("reservedMcpIdentityFor");
    if (override) return override(session);
    const cwd = this.deps.voiceOps.sessionCwd(session);
    const parts: ReservedMcpIdentity[] = [];
    for (const filePath of mcpConfigPaths({
      cwd,
      provider: session.provider,
      grokHome: resolveGrokHome(process.env),
      userHome: process.env.USERPROFILE || process.env.HOME || os.homedir(),
    })) {
      try {
        if (!fs.existsSync(filePath)) continue;
        parts.push(collectReservedMcpIdentity(fs.readFileSync(filePath, "utf8")));
      } catch {
        // Unreadable configs must not block session/new.
      }
    }
    if (session.provider === "grok") parts.push(this.grokMcpReserved);
    return mergeReserved(...parts);
  }

  public async hostMcpServersFor(session: Session): Promise<any[]> {
    const override = this.deps.getOverride?.("hostMcpServersFor");
    if (override) return override(session);
    await this.loadMcpConnectorKeys();
    const store = this.connectedConnectorStore();
    const keyAuth: Record<string, string> = {};
    for (const [id, token] of this.mcpConnectorKeys ?? []) {
      if (store[id]) keyAuth[id] = token;
    }
    const servers = hostMcpServers(
      store,
      this.reservedMcpIdentityFor(session),
      persistConnectorOAuthClientMetadata(store),
      keyAuth,
      this.lapsedOAuthConnectors(store),
    );
    try {
      const askUser = await this.deps.mcpOps.askUserMcpServer(session);
      if (askUser) servers.push(askUser);
    } catch (error) {
      this.deps.host.appendLine(`[ask_user] not offering the question tool: ${(error as Error).message}`);
    }
    try {
      const companions = await this.deps.mcpOps.companionsMcpServer(session);
      if (companions) servers.push(companions);
    } catch (error) {
      this.deps.host.appendLine(`[companions] not offering delegation: ${(error as Error).message}`);
      if (!session.companionsMcpInjected) this.deps.mcpOps.noteCompanionsSkip(session, "pipe-failed");
    }
    return servers;
  }

  public lapsedOAuthConnectors(store = this.connectedConnectorStore()): ReadonlySet<string> {
    const override = this.deps.getOverride?.("lapsedOAuthConnectors");
    if (override) return override(store);
    return connectorsLackingOAuthToken({ store });
  }

  public async loadMcpConnectorKeys(): Promise<void> {
    const override = this.deps.getOverride?.("loadMcpConnectorKeys");
    if (override) return override();
    for (const connector of TIER1_CONNECTORS) {
      if (!isKeyConnector(connector)) continue;
      try {
        const value = await this.deps.context.secrets.get(mcpConnectorSecretKey(connector.id));
        const trimmed = typeof value === "string" ? value.trim() : "";
        if (trimmed) this.mcpConnectorKeys.set(connector.id, trimmed);
        else this.mcpConnectorKeys.delete(connector.id);
      } catch (error) {
        this.deps.host.appendLine(`[mcp] could not read ${connector.id} connector key: ${(error as Error).message}`);
      }
    }
    this.postMcpConnectors();
  }

  public async forgetConnectorKey(id: ConnectorId): Promise<void> {
    const override = this.deps.getOverride?.("forgetConnectorKey");
    if (override) return override(id);
    this.mcpConnectorKeys.delete(id);
    try {
      await this.deps.context.secrets.delete(mcpConnectorSecretKey(id));
    } catch (error) {
      this.deps.host.appendLine(`[mcp] could not delete ${id} connector key: ${(error as Error).message}`);
    }
  }

  public async connectMcpConnector(
    id: string,
    opts: { key?: string; readOnly?: boolean } = {},
  ): Promise<void> {
    const override = this.deps.getOverride?.("connectMcpConnector");
    if (override) return override(id, opts);
    if (!isConnectorId(id)) return;
    if (this.mcpConnectingId) {
      this.mcpConnectError = {
        id,
        message: this.mcpConnectingId === id
          ? "Sign-in is already in progress. Finish the browser prompt, or wait for it to time out."
          : `Already connecting ${this.mcpConnectingId}. Wait for that to finish.`,
      };
      this.postMcpConnectors();
      return;
    }
    const connector = connectorById(id);
    if (!connector) return;
    const store = this.connectedConnectorStore();
    const endpoint = store[id]?.endpoint || connector.endpoint;
    if (isKeyConnector(connector)) {
      await this.connectKeyMcpConnector(connector, endpoint, opts);
      return;
    }
    this.mcpConnectingId = id;
    this.mcpConnectError = undefined;
    this.postMcpConnectors();
    const npx = npxSpawnPlan(process.platform);
    let metadata: { path: string; dispose: () => void } | undefined;
    try {
      if (connector.oauthScope?.trim()) {
        metadata = writeOAuthClientMetadataFile(connector.oauthScope.trim());
      }
      const result = await authorizeMcpRemote({
        spawn,
        command: npx.command,
        args: mcpRemoteArgs(endpoint, undefined, metadata?.path),
        shell: npx.shell,
        env: npx.env,
      });
      if (this.mcpConnectingId !== id) return;
      if (!result.ok) {
        this.mcpConnectError = { id, message: (result as any).message || "Sign-in was not completed." };
        return;
      }
      await this.deps.state.update(
        MCP_CONNECTORS_KEY,
        connectConnector(this.connectedConnectorStore(), id, endpoint),
      );
      this.mcpConnectError = undefined;
    } catch (error) {
      this.mcpConnectError = { id, message: (error as Error).message || "Could not connect." };
    } finally {
      try { metadata?.dispose(); } catch { /* best-effort */ }
      if (this.mcpConnectingId === id) this.mcpConnectingId = undefined;
      this.postMcpConnectors();
    }
  }

  public async connectKeyMcpConnector(
    connector: ConnectorDef,
    endpoint: string,
    opts: { key?: string; readOnly?: boolean },
  ): Promise<void> {
    const override = this.deps.getOverride?.("connectKeyMcpConnector");
    if (override) return override(connector, endpoint, opts);
    const id = connector.id;
    const incoming = typeof opts.key === "string" ? opts.key.trim() : "";
    if (incoming.length > MAX_CONNECTOR_KEY_CHARS) {
      this.mcpConnectError = { id, message: "That token is too long." };
      this.postMcpConnectors();
      return;
    }
    const token = incoming || this.mcpConnectorKeys.get(id) || "";
    const store = this.connectedConnectorStore();
    if (typeof opts.readOnly === "boolean" && !incoming && store[id] && this.mcpConnectorKeys.has(id)) {
      await this.deps.state.update(
        MCP_CONNECTORS_KEY,
        connectConnector(store, id, endpoint, opts.readOnly),
      );
      this.mcpConnectError = undefined;
      this.postMcpConnectors();
      return;
    }
    if (!token) {
      this.mcpConnectError = { id, message: "Paste a personal access token to connect." };
      this.postMcpConnectors();
      return;
    }
    this.mcpConnectingId = id;
    this.mcpConnectError = undefined;
    this.postMcpConnectors();
    const npx = npxSpawnPlan(process.platform);
    try {
      const result = await authorizeMcpRemote({
        spawn,
        command: npx.command,
        args: mcpRemoteArgs(endpoint, undefined, undefined, {
          authorization: true,
          readOnly: opts.readOnly === true || (!incoming && store[id]?.readOnly === true),
        }),
        shell: npx.shell,
        env: withAuthHeaderEnv(npx.env, token),
        auth: "key",
      });
      if (this.mcpConnectingId !== id) return;
      if (!result.ok) {
        this.mcpConnectError = { id, message: (result as any).message || "Sign-in was not completed." };
        return;
      }
      const header = bearerAuthorizationHeader(token);
      if (header) {
        await this.deps.context.secrets.store(mcpConnectorSecretKey(id), token);
        this.mcpConnectorKeys.set(id, token);
      }
      const readOnly = opts.readOnly === true
        || (typeof opts.readOnly !== "boolean" && this.connectedConnectorStore()[id]?.readOnly === true);
      await this.deps.state.update(
        MCP_CONNECTORS_KEY,
        connectConnector(this.connectedConnectorStore(), id, endpoint, readOnly),
      );
      this.mcpConnectError = undefined;
    } catch {
      this.mcpConnectError = { id, message: "Could not save this connector's key. Try connecting again." };
    } finally {
      if (this.mcpConnectingId === id) this.mcpConnectingId = undefined;
      this.postMcpConnectors();
    }
  }

  public async disconnectMcpConnector(id: string): Promise<void> {
    const override = this.deps.getOverride?.("disconnectMcpConnector");
    if (override) return override(id);
    if (!isConnectorId(id)) return;
    if (this.mcpConnectingId === id) return;
    const connector = connectorById(id);
    if (isKeyConnector(connector)) await this.forgetConnectorKey(id);
    await this.deps.state.update(MCP_CONNECTORS_KEY, disconnectConnector(this.connectedConnectorStore(), id));
    if (this.mcpConnectError?.id === id) this.mcpConnectError = undefined;
    this.postMcpConnectors();
  }

  public findLiveGrokSession(): Session | undefined {
    const override = this.deps.getOverride?.("findLiveGrokSession");
    if (override) return override();
    const seen = new Set<Session>();
    for (const candidate of [this.deps.getFocused(), ...this.deps.getPool()]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      if (candidate.provider === "grok" && candidate.client) return candidate;
    }
    return undefined;
  }

  public async grokSessionForMcpList(requester: Session): Promise<Session | undefined> {
    const override = this.deps.getOverride?.("grokSessionForMcpList");
    if (override) return override(requester);
    const live = this.findLiveGrokSession();
    if (live) return live;
    if (this.grokSessionForMcpListInFlight) return this.grokSessionForMcpListInFlight;
    if (!this.deps.mcpOps.connectedProviders().includes("grok")) return undefined;
    const pending = (async (): Promise<Session | undefined> => {
      const seen = new Set<Session>();
      let grok: Session | undefined;
      for (const candidate of [this.deps.getFocused(), ...this.deps.getPool()]) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        if (candidate.provider === "grok") {
          grok = candidate;
          break;
        }
      }
      if (!grok) {
        grok = this.deps.mcpOps.newLocalSession();
        grok.provider = "grok";
        this.deps.mcpOps.setSessionCwd(grok, this.deps.voiceOps.sessionCwd(requester), this.deps.voiceOps.workspaceRoot());
      }
      await this.deps.mcpOps.startSession(undefined, grok, "ensure");
      return grok.client ? grok : undefined;
    })();
    this.grokSessionForMcpListInFlight = pending;
    const clear = () => {
      if (this.grokSessionForMcpListInFlight === pending) {
        this.grokSessionForMcpListInFlight = undefined;
      }
    };
    void pending.then(clear, clear);
    return pending;
  }

  public async refreshMcpServers(session: Session): Promise<void> {
    const override = this.deps.getOverride?.("refreshMcpServers");
    if (override) return override(session);
    this.postMcpServers({
      type: "mcpServers",
      servers: this.mcpServersView,
      loading: true,
      warning: MCP_GLOBAL_SCOPE_WARNING,
    });
    const grokConnected = this.deps.mcpOps.connectedProviders().includes("grok");
    const grok = await this.grokSessionForMcpList(session);
    const client = grok?.client;
    if (!grok || !client) {
      this.mcpListSupported = undefined;
      this.mcpServers = [];
      this.mcpServersCwd = undefined;
      this.mcpServersView = [];
      this.postMcpServers({
        type: "mcpServers",
        servers: [],
        error: grokConnected
          ? "Could not load MCP servers from Grok."
          : "Connect Grok to inspect MCP servers.",
        warning: MCP_GLOBAL_SCOPE_WARNING,
      });
      return;
    }
    try {
      const result = await client.listMcpServers();
      if (grok.client !== client) return;
      if (result === "unsupported") {
        this.mcpListSupported = false;
        this.mcpServers = [];
        this.mcpServersCwd = undefined;
        this.mcpServersView = [];
        this.postMcpServers({
          type: "mcpServers",
          servers: [],
          warning: MCP_GLOBAL_SCOPE_WARNING,
        });
        return;
      }
      this.mcpListSupported = true;
      this.mcpServers = parseMcpListResponse(result);
      this.mcpServersCwd = this.deps.voiceOps.sessionCwd(grok) || undefined;
      this.mcpServersView = this.filterMcpServers(this.mcpServers);
      this.grokMcpReserved = reservedFromMcpInventory(this.mcpServers, this.connectedConnectorStore());
      this.postMcpServers({
        type: "mcpServers",
        servers: this.mcpServersView,
        warning: MCP_GLOBAL_SCOPE_WARNING,
      });
    } catch (error) {
      const detail = errorDetail(error);
      this.deps.host.appendLine(`[mcp] _x.ai/mcp/list failed: ${detail}`);
      this.postMcpServers({
        type: "mcpServers",
        servers: [],
        error: detail || "Could not load MCP servers from Grok.",
        warning: MCP_GLOBAL_SCOPE_WARNING,
      });
    }
  }

  // ── Media & Attachments Subsystem ────────────────────────────────────────

  public isServableFromDisk(p: string, provider: AcpProvider = "grok"): boolean {
    const override = this.deps.getOverride?.("isServableFromDisk");
    if (override) return override(p, provider);
    try {
      if (provider === "codex") {
        return isTrustedCodexGeneratedImagePath(
          p,
          resolveCodexHome(process.env),
          (candidate) => fs.realpathSync(candidate),
        );
      }
      const home = resolveGrokHome();
      return isTrustedGeneratedMediaPath(p, home, (candidate) => fs.realpathSync(candidate));
    } catch {
      return false;
    }
  }

  public async postGeneratedMedia(m: MediaRef, session: Session, gen: number): Promise<void> {
    const override = this.deps.getOverride?.("postGeneratedMedia");
    if (override) return override(m, session, gen);
    try {
      if (m.kind === "data") {
        const decoded = base64DecodedByteLength(m.data);
        if (decoded > MAX_INLINE_MEDIA_BYTES) {
          this.deps.host.appendLine(
            `[media] refused oversized inline media (${decoded} > ${MAX_INLINE_MEDIA_BYTES})`,
          );
          return;
        }
        this.deps.mediaOps.emit(session, { type: "media", media: m.media, src: `data:${m.mimeType};base64,${m.data}` });
        return;
      }
      if (m.kind === "uri") {
        this.deps.mediaOps.emit(session, { type: "media", media: m.media, url: m.uri });
        return;
      }
      if (!this.isServableFromDisk(m.path, session.provider)) {
        this.deps.host.appendLine(`[media] refused generated media path outside its trusted root`);
        return;
      }
      const mime = m.mimeType || guessMediaMime(m.path);
      const webview = this.deps.mediaOps.getViewWebview();
      if (webview) {
        const src = webview.asWebviewUri(Uri.file(m.path));
        const fullId = m.media === "image" && m.path && this.deps.mediaOps.isImagePathAuthorizedNow(m.path, session)
          ? this.deps.mediaOps.registerFullImage(m.path)
          : undefined;
        this.deps.mediaOps.emit(session, { type: "media", media: m.media, src, mimeType: mime, path: m.path, fullId });
        return;
      }
      const bytes = await this.deps.host.fs.readFile(Uri.file(m.path));
      if (gen !== session.gen) return;
      if (bytes.byteLength > MAX_INLINE_MEDIA_BYTES) {
        this.deps.host.appendLine(
          `[media] refused oversized media for data: inline (${bytes.byteLength} > ${MAX_INLINE_MEDIA_BYTES}): ${m.path}`,
        );
        return;
      }
      const b64 = Buffer.from(bytes).toString("base64");
      this.deps.mediaOps.emit(session, { type: "media", media: m.media, src: `data:${mime};base64,${b64}`, path: m.path });
    } catch (e) {
      this.deps.host.appendLine(`[media] failed to forward generated media: ${(e as Error).message}`);
    }
  }

  public async exportExpr(
    msg: {
      action: string;
      kind: string;
      current?: string;
      svg?: string;
      png?: string;
      svgDark?: string;
      svgLight?: string;
    },
    session: Session,
  ): Promise<void> {
    const override = this.deps.getOverride?.("exportExpr");
    if (override) return override(msg, session);
    try {
      const base = msg.kind === "mermaid" ? "diagram" : "equation";
      const toBytes = (png?: string) =>
        png ? Buffer.from(png.split(",")[1] ?? "", "base64") : null;

      if (msg.action === "open") {
        const pngBytes = toBytes(msg.png);
        const dir = path.join(this.deps.context.globalStorageUri.fsPath, "exports");
        fs.mkdirSync(dir, { recursive: true });
        const stamp = Date.now();
        const file = path.join(dir, `${base}-${stamp}.${pngBytes ? "png" : "svg"}`);
        fs.writeFileSync(file, pngBytes ?? (msg.svg ?? ""), pngBytes ? undefined : "utf8");
        await this.deps.host.openHostResolvedPath?.(file);
        return;
      }

      const mark = (which: string) => (msg.current === which ? "  (current theme)" : "");
      const items = [
        { label: "PNG", description: "raster, VS Code theme background", fmt: "png" },
        { label: `SVG — for dark background${mark("dark")}`, description: "transparent, light ink", fmt: "svgDark" },
        { label: `SVG — for light background${mark("light")}`, description: "transparent, dark ink", fmt: "svgLight" },
      ];
      const pick = await this.deps.host.showQuickPick(items, {
        placeHolder: `Export ${base} as…`,
      });
      if (!pick) return;

      const ext = pick.fmt === "png" ? "png" : "svg";
      const defaultName = `${base}.${ext}`;
      const defaultPath = path.join(this.deps.voiceOps.sessionCwd(session), defaultName);
      const filters: Record<string, string[]> =
        ext === "png" ? { "PNG image": ["png"] } : { "SVG image": ["svg"] };
      const target = await this.deps.host.showSaveDialog({ defaultPath, filters });
      if (!target) return;

      if (pick.fmt === "png") {
        const pngBytes = toBytes(msg.png);
        fs.writeFileSync(target, pngBytes ?? Buffer.from(msg.svgDark ?? "", "utf8"));
      } else {
        const svg = pick.fmt === "svgDark" ? msg.svgDark : msg.svgLight;
        fs.writeFileSync(target, svg ?? "", "utf8");
      }
    } catch (e) {
      this.deps.host.appendLine(`[export] failed: ${(e as Error).message}`);
      void this.deps.host.showErrorMessage(`Export failed: ${(e as Error).message}`);
    }
  }

  public async addDroppedFile(
    dropped: string,
    shiftHeld: boolean,
    owner: AttachmentOwner = () => this.deps.getFocused(),
  ): Promise<Session | undefined> {
    const override = this.deps.getOverride?.("addDroppedFile");
    if (override) return override(dropped, shiftHeld, owner);
    let absPath = dropped;
    if (/^file:\/\//i.test(dropped)) {
      try {
        absPath = fileUriToPath(dropped);
      } catch {
        return;
      }
    }
    if (!fs.existsSync(absPath)) return;
    if (!shiftHeld && isVisionImagePath(absPath)) {
      try {
        const imported = await this.deps.mediaOps.importImageFromDisk(absPath, owner);
        if (imported === undefined) return undefined;
        if (imported) return imported;
      } catch (e) {
        this.deps.host.appendLine(`[image] import failed for ${absPath}: ${(e as Error).message}`);
      }
    }
    const session = owner();
    if (!session) return undefined;
    const relPath = normalizeRelPath(path.relative(this.deps.voiceOps.sessionCwd(session), absPath));
    if (shiftHeld) {
      let totalLines: number | undefined;
      try {
        if (shouldReadFileInline(fs.statSync(absPath).size)) {
          totalLines = fs.readFileSync(absPath, "utf8").split("\n").length;
        }
      } catch {
        /* fall back to a no-selection chip */
      }
      session.chips.push(
        totalLines != null
          ? makeExplicitChip(absPath, relPath, 1, totalLines)
          : makeExplicitChip(absPath, relPath),
      );
    } else {
      session.chips.push(makeExplicitChip(absPath, relPath));
    }
    this.deps.mediaOps.postChips(session);
    return session;
  }
}
