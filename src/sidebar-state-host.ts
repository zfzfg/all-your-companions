/**
 * SidebarStateHost: webview initial state building, rehydration replay,
 * and context chip localization.
 *
 * Extracted from GrokSidebar as part of W-15 (Step S7f).
 */

import * as fs from "node:fs";
import { Uri, type Host, type HostContext, type HostWebview, type HostWebviewView } from "./host";
import type { HostMsg } from "./protocol";
import { HOST_CAPABILITIES } from "./protocol";
import type { Session } from "./session";
import { rehydrateBusyChrome, sessionUiSnapshot } from "./session";
import { isFileChip, type ContextChip } from "./context-chips";
import { isImageChip, type FileChip } from "./chips";
import type { PromptImageInput } from "./prompt-builder";
import type { MementoLike } from "./usage-host";
import {
  APP_PURPOSE_KEY,
  DEFAULT_APP_PURPOSE,
  parseAppPurpose,
  type AppPurpose,
} from "./app-purpose";
import {
  MOVE_VIEW_HINT_USED_KEY,
  shouldShowMoveViewHint,
} from "./view-move";
import {
  commandLanguageForDialect,
  resolvedTerminalShellDialect,
} from "./terminal-manager";
import { rememberedEffort, type EffortPrefs } from "./mode-prefs";

export interface SidebarStateHostDeps {
  host: Host;
  state: MementoLike;
  context: HostContext;
  getFocused(): Session;
  getView(): HostWebviewView | undefined;
  post(msg: any): void;
  emit(session: Session, msg: HostMsg): void;
  workspaceRoot(): string;
  canAddProjectFolder(): boolean;
  touch(session: Session): void;
  markRead(session: Session): void;
  refreshWorkflowCompletions(session: Session): void;
  displayMode(session: Session): any;
  postWorkflowList(session: Session): void;
  postMode(): void;
  postRepoCatalog(): void;
  postSessionsList(): void;
  postSessionName(session: Session): void;
  registerFullImage(path: string): string;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
}

export class SidebarStateHost {
  constructor(private readonly deps: SidebarStateHostDeps) {}

  public async retireMoveViewHint(): Promise<void> {
    await this.deps.state.update(MOVE_VIEW_HINT_USED_KEY, true);
    this.deps.post({ type: "moveViewHint", value: false });
  }

  public appPurpose(): AppPurpose {
    return parseAppPurpose(this.deps.state.get<string>(APP_PURPOSE_KEY));
  }

  public buildInitialStateMsg(session: Session = this.deps.getFocused()): Extract<HostMsg, { type: "initialState" }> {
    const cfg = this.deps.host.getConfiguration("grok");
    const cwd = this.deps.workspaceRoot();
    const commandLanguage = commandLanguageForDialect(resolvedTerminalShellDialect());
    return {
      type: "initialState",
      effort: session.client?.currentReasoningEffort || rememberedEffort(
        cfg.get<EffortPrefs>("defaultEffortByProvider", {}),
        session.provider,
        cfg.get<string>("defaultEffort", ""),
      ),
      cwd,
      useCtrlEnter: cfg.get("useCtrlEnterToSend", false),
      extVersion: this.deps.context.extensionVersion,
      showThinking: cfg.get("showThinking", false),
      expandCommandOutputs: cfg.get("expandCommandOutputs", false),
      steerByDefault: cfg.get("steerByDefault", false),
      promptNav: cfg.get<boolean>("promptNav", true) !== false,
      soundNotifications: cfg.get("soundNotifications", false),
      processingSound: cfg.get("processingSound", false),
      readRepliesAloud: cfg.get("readRepliesAloud", false),
      telemetryEnabled: cfg.get("telemetry.enabled", true),
      thumbsFeedback: cfg.get("thumbsFeedback", false),
      appPurpose: this.appPurpose() || DEFAULT_APP_PURPOSE,
      ...(commandLanguage ? { commandLanguage } : {}),
      hostKind: this.deps.host.canSwitchWorkspaceFolder ? "desktop" : "extension",
      capabilities: {
        ...HOST_CAPABILITIES,
        relocateView: this.deps.host.canRelocateView,
        secondarySideBar: this.deps.host.canUseSecondarySideBar,
        moveViewHint: shouldShowMoveViewHint({
          hostAcceptedSecondarySideBar: this.deps.host.canUseSecondarySideBar,
          canRelocateView: this.deps.host.canRelocateView,
          pickerAlreadyUsed: this.deps.state.get<boolean>(MOVE_VIEW_HINT_USED_KEY) === true,
        }),
        showOutput: this.deps.host.canShowOutput,
        toggleDevTools: this.deps.host.canToggleDevTools,
        ...(this.deps.host.canShowMcpSettings ? { mcpSettings: true } : {}),
        openInEditor: this.deps.host.canOpenInEditor,
        servesMediaRanges: this.deps.host.canServeMediaRanges,
        showInFolder: this.deps.host.canShowInFolder,
        previewInApp: this.deps.host.canPreviewInApp,
        settingsEditor: this.deps.host.canOpenSettingsEditor,
        addProjectFolder: this.deps.canAddProjectFolder(),
        createProject: this.deps.canAddProjectFolder(),
        cloneProject: this.deps.canAddProjectFolder(),
        removeProjectFolder: this.deps.canAddProjectFolder(),
      },
    };
  }

  public rehydrateWebviewFromFocused(): void {
    const session = this.deps.getFocused();
    const wv = this.deps.getView()?.webview;
    if (!wv) return;
    this.deps.touch(session);
    this.deps.markRead(session);
    this.deps.refreshWorkflowCompletions(session);
    void wv.postMessage({ type: "clearMessages" });
    void wv.postMessage({ type: "historyReplay", active: true });
    for (const m of session.buffer) {
      void wv.postMessage(this.localizeHistoryMessage(m, wv));
    }
    void wv.postMessage({ type: "historyReplay", active: false });
    for (const m of sessionUiSnapshot(
      session,
      this.deps.displayMode(session),
      this.localPreviewChips(session, wv),
    )) {
      void wv.postMessage(m);
    }
    if (session.sessionType === "crew") this.deps.postWorkflowList(session);
    const chrome = rehydrateBusyChrome(session);
    void wv.postMessage({ type: "setBusy", value: chrome.value, locked: chrome.locked });
    this.deps.postMode();
    this.deps.postRepoCatalog();
    this.deps.postSessionsList();
    this.deps.postSessionName(session);
  }

  public async readImageChip(
    chip: FileChip,
    session: Session,
    gen: number,
  ): Promise<PromptImageInput | "failed" | "gone"> {
    try {
      const bytes = await fs.promises.readFile(chip.path);
      if (bytes.length === 0) throw new Error("file is empty");
      return {
        index: chip.imageIndex!,
        mimeType: chip.mimeType ?? "image/png",
        data: bytes.toString("base64"),
        path: chip.path,
        relPath: chip.originRelPath,
      };
    } catch (e) {
      if (gen !== session.gen) return "gone";
      this.deps.emit(session, {
        type: "agentError",
        text: `Could not read ${chip.relPath} (${(e as Error).message}). Remove the attachment and try again.`,
      });
      return "failed";
    }
  }

  public postChips(session: Session = this.deps.getFocused()): void {
    const focused = this.deps.getFocused();
    const view = this.deps.getView();
    if (session === focused && view) {
      const webview = view.webview;
      const localMessage: HostMsg = { type: "chips", chips: this.localPreviewChips(session, webview) };
      void webview.postMessage(localMessage);
    }
  }

  public localPreviewChips(session: Session, webview: HostWebview): ContextChip[] {
    return session.chips.map((chip) => isFileChip(chip) && isImageChip(chip)
      ? { ...chip, previewSrc: webview.asWebviewUri(Uri.file(chip.path)), fullId: this.deps.registerFullImage(chip.path) }
      : chip);
  }

  public localizeHistoryMessage(message: HostMsg, webview: HostWebview): HostMsg {
    if (message.type === "userMessage" && message.chips) {
      return { ...message, chips: message.chips.map((chip) => isFileChip(chip) && isImageChip(chip)
        ? { ...chip, ...(fs.existsSync(chip.path)
          ? { previewSrc: webview.asWebviewUri(Uri.file(chip.path)), fullId: this.deps.registerFullImage(chip.path) }
          : {}) }
        : chip) };
    }
    if (message.type === "queuedSends" && message.queued) {
      return {
        ...message,
        queued: message.queued.map((item) => ({
          ...item,
          ...(item.chips ? { chips: item.chips.map((chip) => isFileChip(chip) && isImageChip(chip)
            ? { ...chip, ...(fs.existsSync(chip.path)
              ? { previewSrc: webview.asWebviewUri(Uri.file(chip.path)), fullId: this.deps.registerFullImage(chip.path) }
              : {}) }
            : chip) } : {}),
        })),
      };
    }
    if (message.type === "userMessageChunk" && message.images) {
      return {
        ...message,
        images: message.images.map((image) => image.path && fs.existsSync(image.path)
          ? { ...image, previewSrc: webview.asWebviewUri(Uri.file(image.path)), fullId: this.deps.registerFullImage(image.path) }
          : image),
      };
    }
    return message;
  }
}

export function createSidebarStateHost(deps: SidebarStateHostDeps): SidebarStateHost {
  return new SidebarStateHost(deps);
}
