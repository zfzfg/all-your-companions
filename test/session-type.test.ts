import { describe, it, expect } from "vitest";
import {
  DEFAULT_SESSION_TYPE,
  SESSION_TYPES,
  applySessionTypeSwitch,
  canSwitchSessionType,
  defaultSessionTypeFromSetting,
  effectiveSessionType,
  forkedSessionTypeMeta,
  isHostManagedChild,
  isSessionType,
  isSessionTypeLocked,
  lockSessionType,
  promoteHiddenChild,
  promotedSessionName,
  type SessionTypeMeta,
} from "../src/session-type";

describe("session-type (AP-15)", () => {
  it("offers exactly the two types the spec defines", () => {
    // Asserted rather than derived: a third session type would be a design
    // change (D1), not a refactor.
    expect(SESSION_TYPES).toEqual(["agent", "crew"]);
    expect(DEFAULT_SESSION_TYPE).toBe("agent");
  });

  it("rejects everything that is not a session type", () => {
    expect(isSessionType("agent")).toBe(true);
    expect(isSessionType("crew")).toBe(true);
    // The removed prototype axis. It must never resolve again.
    expect(isSessionType("single")).toBe(false);
    expect(isSessionType("plan")).toBe(false);
    expect(isSessionType("yolo")).toBe(false);
    expect(isSessionType(undefined)).toBe(false);
    expect(isSessionType(null)).toBe(false);
  });

  describe("ST-3 — legacy sessions read as locked Agent sessions", () => {
    it("treats a missing type as agent without needing a write", () => {
      expect(effectiveSessionType(undefined)).toBe("agent");
      expect(effectiveSessionType({})).toBe("agent");
    });

    it("treats an unknown stored value as agent rather than throwing", () => {
      expect(effectiveSessionType({ sessionType: "single" as never })).toBe("agent");
    });

    it("locks a session that has history but no stamp", () => {
      // This is exactly the legacy case: every session created before AP-15.
      expect(isSessionTypeLocked({}, true)).toBe(true);
      expect(canSwitchSessionType({}, true)).toBe(false);
    });

    it("leaves an empty session switchable", () => {
      expect(isSessionTypeLocked({}, false)).toBe(false);
      expect(canSwitchSessionType({ sessionType: "crew" }, false)).toBe(true);
    });
  });

  describe("ST-1 — pre-lock switching", () => {
    it("rewrites the type and leaves the input untouched", () => {
      const meta: SessionTypeMeta = { sessionType: "agent", subagentsEnabled: true };
      const result = applySessionTypeSwitch(meta, "crew", false);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.meta.sessionType).toBe("crew");
      // Unrelated metadata survives the switch.
      expect(result.meta.subagentsEnabled).toBe(true);
      expect(meta.sessionType).toBe("agent");
    });

    it("switches back and forth freely while the session is empty", () => {
      let meta: SessionTypeMeta = {};
      for (const next of ["crew", "agent", "crew"] as const) {
        const result = applySessionTypeSwitch(meta, next, false);
        expect(result.ok).toBe(true);
        if (result.ok) meta = result.meta;
      }
      expect(meta.sessionType).toBe("crew");
      expect(meta.sessionTypeLockedAt).toBeUndefined();
    });
  });

  describe("ST-2 — the lock", () => {
    it("stamps once and reports the type it locked", () => {
      const locked = lockSessionType({ sessionType: "crew" }, 1_700_000_000_000);
      expect(locked.sessionType).toBe("crew");
      expect(locked.sessionTypeLockedAt).toBe(1_700_000_000_000);
    });

    it("never re-stamps, because several triggers can fire for one send", () => {
      const first = lockSessionType({}, 1000);
      const second = lockSessionType(first, 2000);
      expect(second.sessionTypeLockedAt).toBe(1000);
      expect(second).toBe(first);
    });

    it("defaults an unset type to agent as it locks", () => {
      expect(lockSessionType(undefined, 5).sessionType).toBe("agent");
    });

    it("refuses a switch after the stamp, even with no history", () => {
      // The host, not the webview, is the authority (§5.6): a forged message
      // from a webview that never hid the control still bounces.
      const result = applySessionTypeSwitch({ sessionType: "agent", sessionTypeLockedAt: 1 }, "crew", false);
      expect(result).toEqual({ ok: false, reason: "locked", sessionType: "agent" });
    });

    it("refuses an unknown target type", () => {
      const result = applySessionTypeSwitch({}, "single", false);
      expect(result).toEqual({ ok: false, reason: "unknown-type", sessionType: "agent" });
    });
  });

  describe("ST-4 — rewind never unlocks", () => {
    it("keeps the lock when the visible history is gone", () => {
      // Rewinding to before the first message empties the transcript. The
      // stamp records that the conversation started, not what is on screen.
      const meta: SessionTypeMeta = { sessionType: "crew", sessionTypeLockedAt: 42 };
      expect(isSessionTypeLocked(meta, false)).toBe(true);
      expect(applySessionTypeSwitch(meta, "agent", false).ok).toBe(false);
    });
  });

  describe("fork", () => {
    it("inherits the type and is born locked", () => {
      const fork = forkedSessionTypeMeta({ sessionType: "crew" }, 99);
      expect(fork.sessionType).toBe("crew");
      expect(fork.sessionTypeLockedAt).toBe(99);
    });

    it("carries no parent-only pointers into the fork", () => {
      const fork = forkedSessionTypeMeta(
        { sessionType: "crew", crewRunId: "run-1", subagents: ["sa_1"] },
        99,
      );
      expect(fork.crewRunId).toBeUndefined();
      expect(fork.subagents).toBeUndefined();
    });
  });

  describe("promote to a session of its own (§6.6 point 8, P6)", () => {
    it("drops exactly the four fields that made it belong to someone else", () => {
      // The child was always a real session for its provider — it was only
      // hidden by OUR metadata, so promoting is a deletion, not a construction.
      const result = promoteHiddenChild({
        sessionType: "agent",
        sessionTypeLockedAt: 5,
        hiddenReason: "companion-subagent",
        parentSessionId: "parent-1",
        subagentId: "sa_1",
        depth: 1,
        subagentsEnabled: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.meta).toEqual({
        sessionType: "agent",
        sessionTypeLockedAt: 5,
        subagentsEnabled: true,
      });
    });

    it("makes the session visible to the history filter", () => {
      // isHostManagedChild is what both the history filter and the sweep read.
      const result = promoteHiddenChild({ hiddenReason: "companion-subagent", depth: 1 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(isHostManagedChild(result.meta)).toBe(false);
    });

    it("resets the depth, so a promoted grandchild is not barred from delegating", () => {
      const result = promoteHiddenChild({ hiddenReason: "companion-subagent", depth: 2 });
      expect(result.ok && result.meta.depth).toBeUndefined();
    });

    it("promotes a crew stage too — it is the same kind of hidden child", () => {
      expect(promoteHiddenChild({ hiddenReason: "crew-stage" }).ok).toBe(true);
    });

    it("refuses a generator session", () => {
      // A transient the host drives through validate-and-submit, carrying a
      // tool set no user session should have (§8.6).
      expect(promoteHiddenChild({ hiddenReason: "workflow-generator" }))
        .toEqual({ ok: false, reason: "generator" });
    });

    it("refuses a session that was never a child", () => {
      expect(promoteHiddenChild({ sessionType: "agent" }))
        .toEqual({ ok: false, reason: "not-a-child" });
      expect(promoteHiddenChild(undefined)).toEqual({ ok: false, reason: "not-a-child" });
    });

    it("names the promoted session after its label and its parent", () => {
      expect(promotedSessionName("Auth inspector", "Refactor auth"))
        .toBe("Auth inspector (from Refactor auth)");
    });

    it("does not stack the suffix when promoting something already named", () => {
      expect(promotedSessionName("Auth inspector (from Refactor auth)", "Refactor auth"))
        .toBe("Auth inspector (from Refactor auth)");
    });

    it("falls back to a usable name rather than an empty one", () => {
      expect(promotedSessionName("", "Refactor auth")).toBe("Subagent (from Refactor auth)");
      expect(promotedSessionName("Auth inspector", "")).toBe("Auth inspector");
    });
  });

  describe("the default setting", () => {
    it("takes a valid configured value", () => {
      expect(defaultSessionTypeFromSetting("crew")).toBe("crew");
    });

    it("falls back rather than letting a bad setting block a new session", () => {
      for (const bad of [undefined, null, "", "single", 7, {}]) {
        expect(defaultSessionTypeFromSetting(bad)).toBe("agent");
      }
    });
  });

  describe("host-managed children", () => {
    it("recognises every hidden kind", () => {
      expect(isHostManagedChild({ hiddenReason: "companion-subagent" })).toBe(true);
      expect(isHostManagedChild({ hiddenReason: "crew-stage" })).toBe(true);
      expect(isHostManagedChild({ hiddenReason: "workflow-generator" })).toBe(true);
    });

    it("leaves ordinary sessions alone", () => {
      expect(isHostManagedChild({ sessionType: "crew", crewRunId: "run-1" })).toBe(false);
      expect(isHostManagedChild(undefined)).toBe(false);
    });
  });
});
