/**
 * AP-07 host wiring: the engine hangs AFTER the plan-gate block and BEFORE
 * the card is emitted. Empty user rules fall through byte-for-byte; a match
 * answers without a card and leaves a transcript line.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import type { PermissionRequest } from "../src/acp";

const sidebarSrc = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

function harness() {
  const posted: unknown[] = [];
  const replies: Array<{ id: PermissionRequest["id"]; optionId?: string; cancelled?: boolean }> = [];
  const sidebar: any = Object.create(GrokSidebar.prototype);
  sidebar.permissionAdoptionPrompted = new Set();
  sidebar.state = { get: () => ({}), update: vi.fn(async () => {}) };
  sidebar.emit = (_session: Session, message: unknown) => { posted.push(message); };
  sidebar.setStatus = vi.fn();
  sidebar.sessionCwd = () => "/workspace";
  sidebar.pendingConfirms = undefined;
  const session = new Session();
  session.autoApprove = false;
  session.planActive = false;
  const client: any = {
    usesClientPlanGate: false,
    planActive: false,
    respondPermission: (id: PermissionRequest["id"], optionId: string) => {
      replies.push({ id, optionId });
      return true;
    },
    respondPermissionCancelled: (id: PermissionRequest["id"]) => {
      replies.push({ id, cancelled: true });
      return true;
    },
  };
  session.client = client;
  return { sidebar, session, client, posted, replies };
}

const EDIT: PermissionRequest = {
  id: 7,
  sessionId: "s1",
  toolCall: { toolCallId: "tc1", kind: "edit", title: "Edit src/a.ts", rawInput: { path: "src/a.ts" } },
  options: [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Always" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ],
};

const RM_ROOT: PermissionRequest = {
  id: 8,
  sessionId: "s1",
  toolCall: {
    toolCallId: "tc-rm",
    kind: "execute",
    title: "rm -rf /",
    rawInput: { command: "rm -rf /" },
  },
  options: [
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ],
};

const PLAN_REVIEW: PermissionRequest = {
  id: 9,
  sessionId: "s1",
  toolCall: {
    toolCallId: "plan",
    kind: "switch_mode",
    title: "Implement this plan?",
    rawInput: { plan: "# Plan" },
  },
  options: [
    { optionId: "implement_plan", kind: "allow_once", name: "Yes" },
    { optionId: "revise", kind: "reject_once", name: "No" },
  ],
};

describe("hook placement", () => {
  it("applies rules after the plan-gate block and before emitting the card", () => {
    const method = sidebarSrc.slice(
      sidebarSrc.indexOf("private handlePermissionRequest("),
      sidebarSrc.indexOf("private applyPermissionRules("),
    );
    const gate = method.indexOf("shouldRejectPermission");
    const rules = method.indexOf("this.applyPermissionRules");
    const auto = method.indexOf("session.autoApprove");
    const emit = method.indexOf('type: "permissionRequest"');
    expect(gate).toBeGreaterThan(0);
    expect(rules).toBeGreaterThan(gate);
    expect(auto).toBeGreaterThan(rules);
    expect(emit).toBeGreaterThan(auto);
  });
});

describe("applyPermissionRules", () => {
  it("falls through when no user rules match — the card is still emitted", () => {
    const h = harness();
    h.sidebar.handlePermissionRequest(h.session, h.client, EDIT, "/workspace");
    expect(h.replies).toEqual([]);
    expect(h.posted.some((m: any) => m.type === "permissionRequest")).toBe(true);
    expect(h.posted.some((m: any) => m.type === "hostNotice")).toBe(false);
  });

  it("an allow rule answers without a card and leaves a transcript line", () => {
    const h = harness();
    h.sidebar.state.get = (key: string) => {
      if (key === "grok.permissionRules") {
        return {
          r1: {
            id: "r1",
            action: "allow",
            scope: "global",
            createdAt: 1,
            match: { kind: "edit", pathGlob: "src/**" },
          },
        };
      }
      return {};
    };
    h.sidebar.handlePermissionRequest(h.session, h.client, EDIT, "/workspace");
    expect(h.replies).toEqual([{ id: 7, optionId: "once" }]);
    expect(h.posted.some((m: any) => m.type === "permissionRequest")).toBe(false);
    const notice = h.posted.find((m: any) => m.type === "hostNotice") as any;
    expect(notice.level).toBe("info");
    expect(notice.text).toMatch(/Allowed by rule/);
  });

  it("the floor denies rm -rf / even when a user allow-rule matches", () => {
    const h = harness();
    h.sidebar.state.get = (key: string) => {
      if (key === "grok.permissionRules") {
        return {
          yolo: {
            id: "yolo",
            action: "allow",
            scope: "global",
            createdAt: 1,
            match: { kind: "execute", commandPrefix: "rm" },
          },
        };
      }
      return {};
    };
    h.sidebar.handlePermissionRequest(h.session, h.client, RM_ROOT, "/workspace");
    expect(h.replies).toEqual([{ id: 8, optionId: "reject" }]);
    expect(h.posted.some((m: any) => m.type === "permissionRequest")).toBe(false);
    const notice = h.posted.find((m: any) => m.type === "hostNotice") as any;
    expect(notice.level).toBe("warning");
    expect(notice.text).toMatch(/safety floor/);
  });

  it("does not auto-decide a plan-review card", () => {
    const h = harness();
    h.sidebar.state.get = () => ({
      r1: {
        id: "r1",
        action: "allow",
        scope: "global",
        createdAt: 1,
        match: { kind: "other" },
      },
    });
    h.sidebar.handlePermissionRequest(h.session, h.client, PLAN_REVIEW, "/workspace");
    expect(h.replies).toEqual([]);
    expect(h.posted.some((m: any) => m.type === "permissionRequest")).toBe(true);
  });

  it("prefers allow_once so later requests still hit the engine", () => {
    const h = harness();
    h.sidebar.state.get = (key: string) => key === "grok.permissionRules"
      ? {
          r1: {
            id: "r1",
            action: "allow",
            scope: "global",
            createdAt: 1,
            match: { kind: "edit", pathGlob: "src/**" },
          },
        }
      : {};
    h.sidebar.handlePermissionRequest(h.session, h.client, EDIT, "/workspace");
    expect(h.replies[0].optionId).toBe("once");
  });
});
