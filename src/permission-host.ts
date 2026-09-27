/**
 * PermissionHost: permission rules evaluation, persistence, adoption,
 * repository auto-approve consent, and diff content provider.
 *
 * Extracted from GrokSidebar as part of W-15 (Step S7e).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Uri, type Host, type HostTextDocumentContentProvider } from "./host";
import type { HostMsg } from "./protocol";
import type { Session } from "./session";
import type { MementoLike } from "./usage-host";
import {
  globalConfigPath,
  projectConfigPath,
  configForcesAlwaysApprove,
  alwaysApproveSource,
  ensureConfigToml,
  ALWAYS_APPROVE_NOTICE_KEY,
  shouldShowAlwaysApproveNotice,
} from "./grok-config";
import { providerConfigFiles, type ProviderConfigFile } from "./provider-config";
import {
  appendRuleEntry,
  ensureRuleFile,
  resolveRuleFileStates,
  ruleFileCandidates,
  type RuleFile,
  type RuleFileFs,
} from "./rules-files";
import {
  PERMISSION_RULES_KEY,
  PERMISSION_RULES_ADOPTED_KEY,
  PERMISSION_RULES_ORDER_COPY,
  SOCKET_RULE_VIEWS,
  type AdoptionRecord,
  type PermissionRule,
  type PermissionRulesFs,
  type PermissionRuleView,
  activeRulesFrom,
  adoptionKeyFor,
  createRule,
  globalRulesToMap,
  loadWorkspaceRulesFile,
  parseAdoptionMap,
  parseGlobalRulesMap,
  pendingWorkspaceAdoption,
  sanitizeWebviewAllowMatch,
  toRuleView,
  writeWorkspaceRulesFile,
} from "./permission-rules";

export type {
  AdoptionRecord,
  PermissionRule,
  PermissionRulesFs,
  PermissionRuleView,
} from "./permission-rules";

export type { RuleFile, RuleFileFs } from "./rules-files";

export const GROK_DIFF_SCHEME = "grok-diff";

export class GrokDiffContentProvider implements HostTextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  provideTextDocumentContent(uri: Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
  set(uri: Uri, content: string): void {
    this.contents.set(uri.toString(), content);
  }
  delete(...uris: Uri[]): void {
    for (const uri of uris) this.contents.delete(uri.toString());
  }
}

export interface PermissionHostDeps {
  host: Host;
  state: MementoLike;
  emit(session: Session, msg: HostMsg): void;
  post(msg: any): void;
  sessionCwd(session: Session): string;
  workspaceRoot(): string;
  getFocused(): Session;
  getSettingsWebview(): { postMessage(msg: any): Thenable<boolean> } | undefined;
  confirmInChat(session: Session, opts: any): Promise<boolean>;
  getPendingConfirms?(): any;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
}

export class PermissionHost {
  public readonly autoApproveConsented = new Set<string>();
  public permissionAdoptionPrompted = new Set<string>();
  private alwaysApproveNoticeShown = false;

  constructor(private readonly deps: PermissionHostDeps) {}

  public autoApproveSource(cwd: string = this.deps.workspaceRoot()): "project" | "global" | undefined {
    const readSafe = (p?: string): string | undefined => {
      if (!p) return undefined;
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    return alwaysApproveSource({
      project: cwd ? readSafe(projectConfigPath(cwd)) : undefined,
      global: readSafe(globalConfigPath()),
    });
  }

  public async confirmRepoForcedAutoApprove(cwd: string): Promise<boolean> {
    if (!cwd || this.autoApproveSource(cwd) !== "project") return true;
    const key = process.platform === "win32" ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
    if (this.autoApproveConsented.has(key)) return true;
    const ok = await this.deps.host.showWarningMessage(
      `"${path.basename(cwd)}" turns off every permission prompt.\n\n` +
        `This project ships a .grok/config.toml setting permission_mode = "always-approve", which ` +
        `overrides your own setting. The agent will edit files and run commands here without asking ` +
        `you first.\n\nOnly continue if you trust this code.`,
      { modal: true },
      "Continue anyway",
    );
    if (ok !== "Continue anyway") {
      this.deps.host.appendLine(`[trust] declined: ${cwd} forces always-approve`);
      return false;
    }
    this.autoApproveConsented.add(key);
    return true;
  }

  public configForcesAutoApprove(cwd: string = this.deps.workspaceRoot()): boolean {
    const readSafe = (p?: string): string | undefined => {
      if (!p) return undefined;
      try {
        return fs.readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    };
    const globalPath = globalConfigPath();
    const projectPath = cwd ? projectConfigPath(cwd) : undefined;
    return configForcesAlwaysApprove({ project: readSafe(projectPath), global: readSafe(globalPath) });
  }

  public permissionRulesFs(): PermissionRulesFs {
    return {
      existsSync: (p) => fs.existsSync(p),
      readFileSync: (p, encoding) => fs.readFileSync(p, encoding),
      mkdirSync: (p, opts) => { fs.mkdirSync(p, opts); },
      writeFileSync: (p, data) => { fs.writeFileSync(p, data); },
    };
  }

  public loadPermissionRuleState(cwd: string): {
    active: PermissionRule[];
    global: PermissionRule[];
    workspace?: { path: string; raw: string; hash: string; rules: PermissionRule[] };
    adoption?: AdoptionRecord;
    shouldPromptAdoption: boolean;
  } {
    const global = parseGlobalRulesMap(this.deps.state.get(PERMISSION_RULES_KEY, {}));
    const workspace = cwd ? loadWorkspaceRulesFile(cwd, this.permissionRulesFs()) : undefined;
    const adoptionMap = parseAdoptionMap(this.deps.state.get(PERMISSION_RULES_ADOPTED_KEY, {}));
    const adoption = cwd ? adoptionMap[adoptionKeyFor(cwd)] : undefined;
    const shouldPromptAdoption = !!workspace && workspace.rules.length > 0 &&
      (!adoption || adoption.hash !== workspace.hash);
    return {
      active: activeRulesFrom(global, workspace, adoption),
      global,
      workspace,
      adoption,
      shouldPromptAdoption,
    };
  }

  public maybePromptWorkspaceRulesAdoption(
    session: Session,
    cwd: string,
    loaded: ReturnType<PermissionHost["loadPermissionRuleState"]>,
  ): void {
    if (!loaded.shouldPromptAdoption || !cwd) return;
    const prompted = this.permissionAdoptionPrompted;
    const key = adoptionKeyFor(cwd);
    if (prompted.has(key)) return;
    prompted.add(key);
    void this.offerWorkspaceRulesAdoption(session, cwd, loaded);
  }

  public async offerWorkspaceRulesAdoption(
    session: Session,
    cwd: string,
    loaded: ReturnType<PermissionHost["loadPermissionRuleState"]>,
  ): Promise<void> {
    const count = loaded.workspace?.rules.length ?? 0;
    this.deps.emit(session, {
      type: "hostNotice",
      level: "warning",
      text: `This project includes ${count} permission rule${count === 1 ? "" : "s"} that are not active yet. They apply only after you adopt them.`,
    });
    if (this.deps.getPendingConfirms && !this.deps.getPendingConfirms()) return;
    const ok = await this.deps.confirmInChat(session, {
      title: "Adopt this project's permission rules?",
      body: `${path.basename(cwd)} ships .grok/permissions.json (${count} rule${count === 1 ? "" : "s"}). Checked-in rules stay inert until you adopt them — they can auto-allow or auto-deny tool calls.\n\nOnly continue if you trust this repository.`,
      confirmLabel: "Adopt rules",
      danger: true,
    });
    await this.adoptPermissionRules(session, !!ok, cwd);
  }

  public postPermissionRules(session: Session = this.deps.getFocused()): void {
    const cwd = this.deps.sessionCwd(session);
    const loaded = this.loadPermissionRuleState(cwd);
    const userViews: PermissionRuleView[] = [
      ...loaded.global.map(toRuleView),
      ...(loaded.adoption?.status === "adopted" && loaded.workspace &&
        loaded.adoption.hash === loaded.workspace.hash
        ? loaded.workspace.rules.map(toRuleView)
        : []),
    ];
    const pending = pendingWorkspaceAdoption(loaded.workspace, loaded.adoption)
      && loaded.workspace
      ? { path: loaded.workspace.path, ruleCount: loaded.workspace.rules.length, hash: loaded.workspace.hash }
      : undefined;
    const pendingViews: PermissionRuleView[] = pending && loaded.workspace
      ? loaded.workspace.rules.map((r) => {
          const view = toRuleView(r);
          return {
            ...view,
            deletable: false,
            detail: `Not active until adopted. ${view.detail}`,
          };
        })
      : [];
    const message: Extract<HostMsg, { type: "permissionRules" }> = {
      type: "permissionRules",
      rules: [...SOCKET_RULE_VIEWS, ...userViews, ...pendingViews],
      orderCopy: PERMISSION_RULES_ORDER_COPY,
      ...(pending ? { pendingAdoption: pending } : {}),
    };
    this.deps.post(message);
    void this.deps.getSettingsWebview()?.postMessage(message);
  }

  public addSessionAllowRule(session: Session, matchRaw: unknown): void {
    const match = sanitizeWebviewAllowMatch(matchRaw);
    if (!match) return;
    session.sessionPermissionRules = [...(session.sessionPermissionRules ?? []), createRule({
      id: `session-${randomUUID()}`,
      createdAt: Date.now(),
      action: "allow",
      scope: "workspace",
      match,
      note: "this session only",
    })];
  }

  public async persistAllowRuleFromCard(
    session: Session,
    matchRaw: unknown,
  ): Promise<void> {
    const match = sanitizeWebviewAllowMatch(matchRaw);
    if (!match) return;
    const created = createRule({
      id: `pr-${randomUUID()}`,
      createdAt: Date.now(),
      action: "allow",
      scope: "workspace",
      match,
      note: `from card on ${new Date().toISOString().slice(0, 10)}`,
    });
    await this.addPermissionRule(session, created);
  }

  public async addPermissionRule(session: Session, created: PermissionRule): Promise<void> {
    const cwd = this.deps.sessionCwd(session);
    const loaded = this.loadPermissionRuleState(cwd);
    const workspaceWritable = !!cwd &&
      (!loaded.workspace || (loaded.adoption?.status === "adopted" &&
        loaded.adoption.hash === loaded.workspace.hash));
    if (created.scope === "workspace" && workspaceWritable && cwd) {
      const next = [...(loaded.workspace?.rules ?? []), created];
      const written = writeWorkspaceRulesFile(cwd, next, this.permissionRulesFs());
      await this.rememberAdoption(cwd, written.hash, "adopted");
    } else {
      const global = [...loaded.global, { ...created, scope: "global" as const }];
      await this.deps.state.update(PERMISSION_RULES_KEY, globalRulesToMap(global));
    }
    this.postPermissionRules(session);
  }

  public async rememberAdoption(
    cwd: string,
    hash: string,
    status: AdoptionRecord["status"],
  ): Promise<void> {
    const map = parseAdoptionMap(this.deps.state.get(PERMISSION_RULES_ADOPTED_KEY, {}));
    map[adoptionKeyFor(cwd)] = { hash, status, at: Date.now() };
    await this.deps.state.update(PERMISSION_RULES_ADOPTED_KEY, map);
  }

  public async deletePermissionRule(session: Session, id: string): Promise<void> {
    if (!id || id.startsWith("socket-")) return;
    const cwd = this.deps.sessionCwd(session);
    const loaded = this.loadPermissionRuleState(cwd);
    const inGlobal = loaded.global.some((r) => r.id === id);
    if (inGlobal) {
      const next = loaded.global.filter((r) => r.id !== id);
      await this.deps.state.update(PERMISSION_RULES_KEY, globalRulesToMap(next));
    } else if (cwd && loaded.workspace && loaded.adoption?.status === "adopted") {
      const next = loaded.workspace.rules.filter((r) => r.id !== id);
      const written = writeWorkspaceRulesFile(cwd, next, this.permissionRulesFs());
      await this.rememberAdoption(cwd, written.hash, "adopted");
    }
    this.postPermissionRules(session);
  }

  public async adoptPermissionRules(
    session: Session,
    adopt: boolean,
    cwd: string = this.deps.sessionCwd(session),
  ): Promise<void> {
    if (!cwd) return;
    const loaded = this.loadPermissionRuleState(cwd);
    if (!loaded.workspace) return;
    await this.rememberAdoption(cwd, loaded.workspace.hash, adopt ? "adopted" : "declined");
    this.postPermissionRules(session);
    this.deps.emit(session, {
      type: "hostNotice",
      level: "info",
      text: adopt
        ? `Adopted ${loaded.workspace.rules.length} permission rule${loaded.workspace.rules.length === 1 ? "" : "s"} from this project.`
        : "Left this project's permission rules inactive. They stay visible in Settings until adopted.",
    });
  }

  public noticeAlwaysApproveOnce(cwd: string = this.deps.workspaceRoot()): void {
    const shown =
      this.alwaysApproveNoticeShown || this.deps.state.get<boolean>(ALWAYS_APPROVE_NOTICE_KEY) === true;
    if (!shouldShowAlwaysApproveNotice({ source: this.autoApproveSource(cwd), shown })) {
      if (shown) this.alwaysApproveNoticeShown = true;
      return;
    }
    this.alwaysApproveNoticeShown = true;
    void this.deps.state.update(ALWAYS_APPROVE_NOTICE_KEY, true);
    const OPEN = "Open config.toml";
    void this.deps.host.showInformationMessage(
      'Grok: "always-approve" is set in your grok config.toml, so tool actions are auto-approved for every session (CLI and extension). The mode shows "Auto accept" to reflect this — the extension can\'t override a global config setting per-session.',
      OPEN,
    ).then((pick) => {
      if (pick !== OPEN) return;
      void this.deps.host.openGlobalConfig();
    });
  }

  public ruleFileFs(): RuleFileFs {
    return {
      stat: async (absPath) => {
        const s = await this.deps.host.fs.stat(Uri.file(absPath));
        return { isDirectory: (s.type & 2) !== 0, size: s.size };
      },
      readText: async (absPath) => Buffer.from(await this.deps.host.fs.readFile(Uri.file(absPath))).toString("utf8"),
      writeText: async (absPath, content) => {
        await this.deps.host.fs.writeFile(Uri.file(absPath), Buffer.from(content, "utf8"));
      },
      mkdir: async (absPath) => {
        await this.deps.host.fs.createDirectory(Uri.file(absPath));
      },
    };
  }

  public resolvedUserHome(): string {
    const env = process.env;
    return (process.platform === "win32" ? env.USERPROFILE : env.HOME) || os.homedir();
  }

  public async currentRuleFiles(session: Session): Promise<RuleFile[]> {
    const candidates = [...ruleFileCandidates(this.deps.sessionCwd(session), this.resolvedUserHome()), ...providerConfigFiles()];
    return resolveRuleFileStates(candidates, this.ruleFileFs());
  }

  public postRuleFiles(files: RuleFile[]): void {
    const message: Extract<HostMsg, { type: "ruleFiles" }> = { type: "ruleFiles", files };
    this.deps.post(message);
    void this.deps.getSettingsWebview()?.postMessage(message);
  }

  public async refreshRuleFiles(session: Session): Promise<void> {
    this.postRuleFiles(await this.currentRuleFiles(session));
  }

  public async openRuleFile(session: Session, requestedPath: string): Promise<void> {
    const candidates: RuleFile[] = [...ruleFileCandidates(this.deps.sessionCwd(session), this.resolvedUserHome()), ...providerConfigFiles()];
    const target = candidates.find((f) => f.path === requestedPath);
    if (!target) return;
    try {
      if ("config" in target) ensureConfigToml(target.path, (target as ProviderConfigFile).stub);
      else await ensureRuleFile(target, this.ruleFileFs());
    } catch (err) {
      await this.deps.host.showErrorMessage(`Couldn't create ${target.label}: ${(err as Error)?.message || String(err)}`);
      return;
    }
    if (target.kind === "directory") {
      await this.deps.host.showInFolder(target.path);
    } else {
      await this.deps.host.openTextFile(target.path);
    }
    await this.refreshRuleFiles(session);
  }

  public async appendRuleFile(session: Session, text: string): Promise<void> {
    const addition = String(text ?? "");
    if (!addition.trim()) return;
    const candidates = ruleFileCandidates(this.deps.sessionCwd(session), this.resolvedUserHome())
      .filter((f) => f.kind === "file");
    const provider = session.provider;
    const rank = (f: RuleFile) => (f.scope === "project" ? 0 : 10) + (f.providers.includes(provider) ? 0 : 1);
    const ordered = [...candidates].sort((a, b) => rank(a) - rank(b));
    const picks = ordered.map((f) => ({
      label: f.label,
      description: f.exists ? undefined : "Will be created",
      detail: f.path,
      file: f,
    }));
    const picked = await this.deps.host.showQuickPick(picks, {
      title: "Add as rule",
      placeHolder: "Select a rule file to append to",
    });
    if (!picked) return;
    const dateStamp = new Date().toISOString().slice(0, 10);
    try {
      await appendRuleEntry(picked.file, addition, dateStamp, this.ruleFileFs());
    } catch (err) {
      await this.deps.host.showErrorMessage(`Couldn't update ${picked.file.label}: ${(err as Error)?.message || String(err)}`);
      return;
    }
    await this.refreshRuleFiles(session);
  }
}

export function createPermissionHost(deps: PermissionHostDeps): PermissionHost {
  return new PermissionHost(deps);
}
