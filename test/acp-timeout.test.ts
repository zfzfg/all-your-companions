import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMPT_ABSOLUTE_TIMEOUT_MS,
  DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MIN_ACP_TIMEOUT_MS,
  clampAcpTimeoutMs,
  promptTimerDelayMs,
  resolveAcpTimeouts,
} from "../src/acp-timeout";

describe("clampAcpTimeoutMs", () => {
  it("floors positives and raises them to the minimum", () => {
    expect(clampAcpTimeoutMs(1_800_000.9, 1)).toBe(1_800_000);
    expect(clampAcpTimeoutMs(500, DEFAULT_REQUEST_TIMEOUT_MS)).toBe(MIN_ACP_TIMEOUT_MS);
  });

  it("keeps an explicit 0 only when allowZero is set", () => {
    expect(clampAcpTimeoutMs(0, DEFAULT_PROMPT_IDLE_TIMEOUT_MS, { allowZero: true })).toBe(0);
    expect(clampAcpTimeoutMs("0", DEFAULT_PROMPT_ABSOLUTE_TIMEOUT_MS, { allowZero: true })).toBe(0);
    expect(clampAcpTimeoutMs(0, DEFAULT_REQUEST_TIMEOUT_MS)).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("falls back on junk", () => {
    expect(clampAcpTimeoutMs(undefined, 42)).toBe(42);
    expect(clampAcpTimeoutMs(NaN, 42)).toBe(42);
    expect(clampAcpTimeoutMs(-5, 42)).toBe(42);
    expect(clampAcpTimeoutMs("nope", 42)).toBe(42);
  });
});

describe("resolveAcpTimeouts", () => {
  it("uses stock defaults when nothing is set", () => {
    expect(resolveAcpTimeouts()).toEqual({
      promptIdleTimeoutMs: DEFAULT_PROMPT_IDLE_TIMEOUT_MS,
      promptAbsoluteTimeoutMs: DEFAULT_PROMPT_ABSOLUTE_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    });
  });

  it("accepts a disabled idle or absolute cap", () => {
    expect(resolveAcpTimeouts({
      promptIdleTimeoutMs: 0,
      promptAbsoluteTimeoutMs: 0,
    })).toMatchObject({
      promptIdleTimeoutMs: 0,
      promptAbsoluteTimeoutMs: 0,
    });
  });
});

describe("promptTimerDelayMs", () => {
  it("returns the idle remaining when the absolute cap is far away", () => {
    expect(promptTimerDelayMs({
      startedAt: 0,
      lastActivityAt: 1_000,
      now: 1_500,
      idleMs: 1_000,
      absoluteMs: 10_000,
    })).toBe(500);
  });

  it("returns the absolute remaining when it is sooner than idle", () => {
    expect(promptTimerDelayMs({
      startedAt: 0,
      lastActivityAt: 9_500,
      now: 9_600,
      idleMs: 1_000,
      absoluteMs: 10_000,
    })).toBe(400);
  });

  it("returns 0 when either cap has already elapsed", () => {
    expect(promptTimerDelayMs({
      startedAt: 0,
      lastActivityAt: 0,
      now: 2_000,
      idleMs: 1_000,
      absoluteMs: 10_000,
    })).toBe(0);
  });

  it("returns Infinity when both caps are disabled", () => {
    expect(promptTimerDelayMs({
      startedAt: 0,
      lastActivityAt: 0,
      now: 1,
      idleMs: 0,
      absoluteMs: 0,
    })).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("human wait (upstream e2e8458)", () => {
  it("suspends only idle detection during a human wait", () => {
    const args = { startedAt: 0, lastActivityAt: 0, now: 5_000, idleMs: 1_000, absoluteMs: 10_000 };
    expect(promptTimerDelayMs({ ...args, humanWaitActive: false })).toBe(0);
    expect(promptTimerDelayMs({ ...args, humanWaitActive: true })).toBe(5_000);
    expect(promptTimerDelayMs({ ...args, now: 10_000, humanWaitActive: true })).toBe(0);
    expect(promptTimerDelayMs({ ...args, absoluteMs: 0, humanWaitActive: true })).toBe(Infinity);
  });
});
