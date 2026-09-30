import { describe, expect, it, vi } from "vitest";
import {
  mergeContextObservation,
  type ContextObservation,
} from "../src/context-budget";
import { CATALOG_PARSERS, modelsMatch } from "../src/context-catalog";
import {
  DEFAULT_COMPACT_THRESHOLD,
  compactEventKind,
  compactThresholdLine,
  grokCompactThresholdEnv,
} from "../src/grok-compaction";
import {
  autoCompactStartedNote,
  contextUsedFromCompactNotification,
} from "../src/acp-dispatch";
import { createTurnEdit } from "../src/turn-edit";
import { Session } from "../src/session";
import { bootWebview, dispatch, click } from "./webview-harness";

describe("CLI Budget and Compaction Integration", () => {
  const modelsCacheFixture = {
    models: {
      "grok-4.7": {
        id: "grok-4.7",
        name: "Grok 4.7",
        info: {
          context_window: 256000,
          max_completion_tokens: 16384,
          auto_compact_threshold_percent: 80,
        },
      },
      "grok-4.6": {
        id: "grok-4.6",
        name: "Grok 4.6",
        info: {
          context_window: 256000,
          max_completion_tokens: 16384,
          auto_compact_threshold_percent: 80,
        },
      },
    },
  };

  describe("1. Grok 4.6 and 4.7 256k CLI budget vs 500k API maximum", () => {
    it("parses native 256k context window and 80% compaction threshold from CLI models cache", () => {
      const parsed = CATALOG_PARSERS.grok!(modelsCacheFixture);
      expect(parsed).toHaveLength(2);

      const grok47 = parsed.find((m: any) => m.modelId === "grok-4.7");
      expect(grok47).toBeDefined();
      expect(grok47?.limits.contextWindow).toBe(256000);
      expect(grok47?.limits.autoCompactThresholdPercent).toBe(80);

      const grok46 = parsed.find((m: any) => modelsMatch(m.modelId, "grok-4.6"));
      expect(grok46).toBeDefined();
      expect(grok46?.limits.contextWindow).toBe(256000);
      expect(grok46?.limits.autoCompactThresholdPercent).toBe(80);
    });

    it("ensures public 500k API maximum never replaces or enlarges 256k catalog limit", () => {
      const catalogObs: ContextObservation = {
        provider: "grok",
        access: "cli",
        modelId: "grok-4.6",
        sessionId: "s1",
        generation: 1,
        source: "catalog",
        observedAt: 1000,
        limitQuality: "verified",
        usageQuality: "unknown",
        limits: { contextWindow: 256000, autoCompactThresholdPercent: 80 },
        documentedLimits: { contextWindow: 500000 },
      };

      // Unauthoritative session/info reporting server capacity 500k
      const sessionInfoIncoming: ContextObservation = {
        provider: "grok",
        access: "cli",
        modelId: "grok-4.6",
        sessionId: "s1",
        generation: 1,
        source: "session",
        observedAt: 2000,
        limitQuality: "unknown",
        usageQuality: "unknown",
        limits: { contextWindow: 500000 },
      };

      const merged = mergeContextObservation(catalogObs, sessionInfoIncoming);
      expect(merged.limits.contextWindow).toBe(256000);
      expect(merged.source).toBe("catalog");
      expect(merged.limitQuality).toBe("verified");
      expect(merged.documentedLimits?.contextWindow).toBe(500000);
    });

    it("keeps Grok 4.7 budget at 256k even when session/info reports 500k", () => {
      const catalogObs: ContextObservation = {
        provider: "grok",
        access: "cli",
        modelId: "grok-4.7",
        sessionId: "s2",
        generation: 1,
        source: "catalog",
        observedAt: 1000,
        limitQuality: "verified",
        usageQuality: "unknown",
        limits: { contextWindow: 256000, autoCompactThresholdPercent: 80 },
        documentedLimits: { contextWindow: 500000 },
      };

      const sessionInfoIncoming: ContextObservation = {
        provider: "grok",
        access: "cli",
        modelId: "grok-4.7",
        sessionId: "s2",
        generation: 1,
        source: "session",
        observedAt: 2000,
        limitQuality: "unknown",
        usageQuality: "unknown",
        limits: { contextWindow: 500000 },
      };

      const merged = mergeContextObservation(catalogObs, sessionInfoIncoming);
      expect(merged.limits.contextWindow).toBe(256000);
      expect(merged.documentedLimits?.contextWindow).toBe(500000);
    });
  });

  describe("2. Old stored 500k values and delayed model events", () => {
    it("overrides stale persisted 500k value with verified 256k catalog budget", () => {
      const persistedObs: ContextObservation = {
        provider: "grok",
        access: "cli",
        modelId: "grok-4.6",
        sessionId: "old-session",
        generation: 1,
        source: "persisted",
        observedAt: 100,
        limitQuality: "estimated",
        usageQuality: "estimated",
        limits: { contextWindow: 500000 },
        used: 120000,
      };

      const freshCatalogObs: ContextObservation = {
        provider: "grok",
        access: "cli",
        modelId: "grok-4.6",
        sessionId: "old-session",
        generation: 1,
        source: "catalog",
        observedAt: 2000,
        limitQuality: "verified",
        usageQuality: "unknown",
        limits: { contextWindow: 256000, autoCompactThresholdPercent: 80 },
      };

      const merged = mergeContextObservation(persistedObs, freshCatalogObs);
      expect(merged.limits.contextWindow).toBe(256000);
      expect(merged.source).toBe("catalog");
      expect(merged.limitQuality).toBe("verified");
      expect(merged.used).toBe(120000);
    });

    it("rejects delayed model updates that do not match the current model ID", () => {
      expect(modelsMatch("grok-4.6", "grok-4-6")).toBe(true);
      expect(modelsMatch("grok-4.6", "grok-4.6")).toBe(true);
      expect(modelsMatch("grok-4.6", "grok-4.7")).toBe(false);
      expect(modelsMatch("grok-4.7", "grok-4-7")).toBe(true);
    });
  });

  describe("3. Compaction control — no 95% override and native 80% threshold", () => {
    it("never injects a 95% GROK_AUTO_COMPACT_THRESHOLD_PERCENT override into env", () => {
      expect(grokCompactThresholdEnv(95, {})).toBeUndefined();
      expect(grokCompactThresholdEnv(97, {})).toBeUndefined();
      expect(grokCompactThresholdEnv(0, {})).toBeUndefined();
      expect(DEFAULT_COMPACT_THRESHOLD).toBe(80);
    });

    it("formats threshold line with native CLI threshold note when native", () => {
      const line = compactThresholdLine(80, 256000, "native");
      expect(line).toBe("Auto-compacts at 80% (≈ 205k tokens) (native CLI threshold)");
    });

    it("formats threshold line with env note when set via GROK_AUTO_COMPACT_THRESHOLD_PERCENT", () => {
      const line = compactThresholdLine(90, 256000, "env");
      expect(line).toBe("Auto-compacts at 90% (≈ 230k tokens) (via GROK_AUTO_COMPACT_THRESHOLD_PERCENT)");
    });
  });

  describe("4. Popover display requirements", () => {
    it("renders Actual context limit, Limit source, Catalog updated, and Public API maximum", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
      dispatch(window, {
        type: "session",
        sessionId: "s1",
        provider: "grok",
        currentModelId: "grok-4.6",
        models: [{ modelId: "grok-4.6", name: "Grok 4.6", totalContextTokens: 256000 }],
      });
      dispatch(window, {
        type: "contextUsage",
        used: 50000,
        window: 256000,
        autoCompactThresholdPercent: 80,
        thresholdSource: "native",
        context: {
          provider: "grok",
          access: "cli",
          modelId: "grok-4.6",
          source: "catalog",
          observedAt: 1774920000000,
          limitQuality: "verified",
          usageQuality: "verified",
          limits: { contextWindow: 256000 },
          documentedLimits: { contextWindow: 500000 },
        },
      });

      click(window, doc.getElementById("donut")!);
      const text = doc.getElementById("context-popover")!.textContent!;

      expect(text).toContain("Actual context limit");
      expect(text).toMatch(/Actual context limit\s*256[.,]000 tokens/);
      expect(text).toContain("Limit source");
      expect(text).toContain("catalog");
      expect(text).toContain("Catalog updated");
      expect(text).not.toContain("Measured"); // Catalog entries must NEVER be called "Measured"
      expect(text).toMatch(/Public API maximum\s*500[.,]000 tokens/);
      expect(text).toContain("Auto-compacts at 80%");
      expect(text).toContain("(native CLI threshold)");
      expect(text).not.toContain("companions.grok.autoCompactThresholdPercent");
    });

    it("labels unknown context limits explicitly as Unknown", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
      dispatch(window, {
        type: "session",
        sessionId: "s2",
        provider: "grok",
        currentModelId: "custom-model",
      });
      dispatch(window, {
        type: "contextUsage",
        reset: true,
      });

      click(window, doc.getElementById("donut")!);
      const text = doc.getElementById("context-popover")!.textContent!;

      expect(text).toContain("Actual context limit");
      expect(text).toMatch(/Actual context limit\s*Unknown/);
    });

    it("displays user-set threshold transparently with via GROK_AUTO_COMPACT_THRESHOLD_PERCENT", () => {
      const { window, doc } = bootWebview();
      dispatch(window, { type: "initialState", appPurpose: "coding", capabilities: {} } as never);
      dispatch(window, {
        type: "contextUsage",
        used: 10000,
        window: 256000,
        autoCompactThresholdPercent: 90,
        thresholdSource: "env",
      });

      click(window, doc.getElementById("donut")!);
      const text = doc.getElementById("context-popover")!.textContent!;

      expect(text).toContain("Auto-compacts at 90%");
      expect(text).toContain("(via GROK_AUTO_COMPACT_THRESHOLD_PERCENT)");
    });
  });

  describe("5. Native compaction lifecycle events and token occupancy", () => {
    it("parses auto_compact_started note with percentage", () => {
      const note = autoCompactStartedNote({ sessionUpdate: "auto_compact_started", percentage: 80 });
      expect(note).toBe("Auto-compacting context (80% full)…");
    });

    it("extracts tokens_after from auto_compact_completed without inventing tokens", () => {
      const used = contextUsedFromCompactNotification({
        sessionUpdate: "auto_compact_completed",
        tokens_after: 42000,
      });
      expect(used).toBe(42000);

      const invalid = contextUsedFromCompactNotification({
        sessionUpdate: "auto_compact_completed",
        tokens_after: "not-a-number",
      });
      expect(invalid).toBeNull();
    });

    it("recognizes all compaction lifecycle kinds", () => {
      expect(compactEventKind({ sessionUpdate: "auto_compact_started" })).toBe("started");
      expect(compactEventKind({ sessionUpdate: "auto_compact_completed" })).toBe("completed");
      expect(compactEventKind({ sessionUpdate: "auto_compact_failed" })).toBe("failed");
      expect(compactEventKind({ sessionUpdate: "auto_compact_cancelled" })).toBe("cancelled");
    });
  });

  describe("6. Manual compaction safety and turn retry behavior", () => {
    it("preserves draft and chips on error and does NOT retry an already-sent agent turn", async () => {
      const session = new Session();
      session.provider = "grok";
      const chip = { id: "c1", label: "file.ts" } as any;
      const emit = vi.fn();
      const send = vi.fn(async (text: string) => {
        if (text === "/compact") {
          // Compact succeeds
          session.status = "idle";
        }
      });

      const turnEdit = createTurnEdit({
        sidebarOps: {
          emit,
          handleSend: send,
        } as any,
      } as any);

      // notSent is false: turn was already sent to CLI and may have executed tool calls
      session.pendingOverflow = {
        id: "ovf-1",
        text: "Please delete production database and restart",
        chips: [chip],
        notSent: false,
      };

      await turnEdit.answerContextOverflow(session, { id: "ovf-1", action: "compact-retry" });

      // /compact was executed
      expect(send).toHaveBeenCalledWith("/compact", true, session);
      // The dangerous/already-sent prompt must NOT have been sent automatically via handleSend!
      expect(send).not.toHaveBeenCalledWith("Please delete production database and restart", false, session);
      // Instead, draft and chips were restored to composer for user review
      expect(emit).toHaveBeenCalledWith(session, {
        type: "restoreComposer",
        text: "Please delete production database and restart",
      });
      expect(emit).toHaveBeenCalledWith(session, {
        type: "chips",
        chips: [chip],
      });
    });

    it("safely retries the turn if it was blocked locally before sending (notSent: true)", async () => {
      const session = new Session();
      session.provider = "grok";
      const chip = { id: "c2", label: "plan.md" } as any;
      const emit = vi.fn();
      const send = vi.fn(async (text: string) => {
        if (text === "/compact") {
          session.status = "idle";
        }
      });

      const turnEdit = createTurnEdit({
        sidebarOps: {
          emit,
          handleSend: send,
        } as any,
      } as any);

      // notSent is true: turn never reached the CLI
      session.pendingOverflow = {
        id: "ovf-2",
        text: "Safe prompt that was blocked locally",
        chips: [chip],
        notSent: true,
      };

      await turnEdit.answerContextOverflow(session, { id: "ovf-2", action: "compact-retry" });

      expect(send).toHaveBeenCalledWith("/compact", true, session);
      expect(send).toHaveBeenCalledWith("Safe prompt that was blocked locally", false, session);
    });
  });
});
