import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FEEDBACK_RPC_METHOD,
  buildClientFeedbackParams,
  commandsAdvertiseFeedback,
  decideFeedbackAvailability,
  feedbackClientType,
  isFeedbackDisabledError,
  isThumbsRating,
  parseFeedbackEnabledMeta,
} from "../src/feedback";

describe("wire helpers", () => {
  it("sends the ACP extension-prefix method, not the bare logical name", () => {
    expect(FEEDBACK_RPC_METHOD).toBe("_x.ai/feedback");
  });

  it("builds snake_case ClientFeedbackInput without a request_id or turn_number", () => {
    expect(buildClientFeedbackParams({
      sessionId: "s1",
      clientType: "extension",
      ratingValue: 1,
      clientVersion: "3.13.0",
    })).toEqual({
      session_id: "s1",
      client_type: "extension",
      rating_type: "thumbs",
      rating_value: 1,
      client_version: "3.13.0",
    });
    expect(buildClientFeedbackParams({
      sessionId: "s1",
      clientType: "desktop",
      ratingValue: -1,
    })).not.toHaveProperty("turn_number");
  });

  it("describes the host that files the rating, not the phone that clicked", () => {
    expect(feedbackClientType(false)).toBe("extension");
    expect(feedbackClientType(true)).toBe("desktop");
  });

  it("accepts only the thumbs scale", () => {
    expect(isThumbsRating(-1)).toBe(true);
    expect(isThumbsRating(0)).toBe(true);
    expect(isThumbsRating(1)).toBe(true);
    expect(isThumbsRating(2)).toBe(false);
    expect(isThumbsRating("1")).toBe(false);
  });
});

describe("availability", () => {
  it("reads session/new _meta.feedbackEnabled", () => {
    expect(parseFeedbackEnabledMeta({ _meta: { feedbackEnabled: true } })).toBe(true);
    expect(parseFeedbackEnabledMeta({ meta: { feedback_enabled: false } })).toBe(false);
    expect(parseFeedbackEnabledMeta({ sessionId: "s" })).toBeUndefined();
  });

  it("detects the /feedback builtin in available_commands_update", () => {
    expect(commandsAdvertiseFeedback([{ name: "compact" }, { name: "feedback" }])).toBe(true);
    expect(commandsAdvertiseFeedback([{ name: "compact" }])).toBe(false);
  });

  it("is grok-only, off until a positive signal, and latched off on unsupported", () => {
    expect(decideFeedbackAvailability({
      provider: "codex",
      metaEnabled: true,
      latchedUnsupported: false,
      userEnabled: true,
    })).toBe(false);
    expect(decideFeedbackAvailability({
      provider: "claude",
      metaEnabled: true,
      latchedUnsupported: false,
      userEnabled: true,
    })).toBe(false);
    expect(decideFeedbackAvailability({
      provider: "grok",
      latchedUnsupported: false,
      userEnabled: true,
    })).toBe(false);
    expect(decideFeedbackAvailability({
      provider: "grok",
      commandsAdvertise: true,
      latchedUnsupported: false,
      userEnabled: true,
    })).toBe(true);
    expect(decideFeedbackAvailability({
      provider: "grok",
      metaEnabled: true,
      commandsAdvertise: false,
      latchedUnsupported: false,
      userEnabled: true,
    })).toBe(true);
    expect(decideFeedbackAvailability({
      provider: "grok",
      metaEnabled: false,
      commandsAdvertise: true,
      latchedUnsupported: false,
      userEnabled: true,
    })).toBe(false);
    expect(decideFeedbackAvailability({
      provider: "grok",
      metaEnabled: true,
      latchedUnsupported: true,
      userEnabled: true,
    })).toBe(false);
  });

  it("the Settings opt-in is an additional gate: off never, on means when grok supports it", () => {
    expect(decideFeedbackAvailability({
      provider: "grok",
      metaEnabled: true,
      latchedUnsupported: false,
      userEnabled: false,
    })).toBe(false);
    expect(decideFeedbackAvailability({
      provider: "grok",
      commandsAdvertise: true,
      latchedUnsupported: false,
      userEnabled: false,
    })).toBe(false);
    expect(decideFeedbackAvailability({
      provider: "codex",
      metaEnabled: true,
      latchedUnsupported: false,
      userEnabled: true,
    })).toBe(false);
  });

  it("threads grok.thumbsFeedback through the host without latching a setting-off click", () => {
    const src = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
    const turnEditSrc = readFileSync(new URL("../src/turn-edit.ts", import.meta.url), "utf8");
    const inbound = readFileSync(new URL("../src/sidebar-inbound.ts", import.meta.url), "utf8");
    expect(src).toContain("userEnabled: this.thumbsFeedbackEnabled()");
    expect(inbound).toContain('update("thumbsFeedback"');
    const viewHostSrc = readFileSync(new URL("../src/sidebar-view-host.ts", import.meta.url), "utf8");
    expect(viewHostSrc).toMatch(/affectsConfiguration\("grok\.thumbsFeedback"\)/);
    const start = turnEditSrc.indexOf("public async handleTurnFeedback(");
    const end = turnEditSrc.indexOf("public async forkFocusedSession", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = turnEditSrc.slice(start, end);
    expect(body).toMatch(/if \(!this\.(?:deps\.feedbackOps\.)?thumbsFeedbackEnabled\(\)\)/);
    expect(body.search(/if \(!this\.(?:deps\.feedbackOps\.)?thumbsFeedbackEnabled\(\)\)/)).toBeLessThan(body.indexOf("latchFeedbackUnavailable"));
  });

  it("treats the disabled internal_error as a capability gap, not a send failure", () => {
    expect(isFeedbackDisabledError({
      code: -32603,
      message: "Internal error",
      data: "Feedback is disabled. To enable, set GROK_FEEDBACK_ENABLED=true",
    })).toBe(true);
    expect(isFeedbackDisabledError({ code: -32603, message: "Internal error" })).toBe(false);
    expect(isFeedbackDisabledError({ code: -32601, message: "Method not found" })).toBe(false);
  });
});
