import { describe, expect, it } from "vitest";
import { Session, sessionUiSnapshot } from "../src/session";
import { allProviderCapabilities } from "../src/provider-capabilities";

describe("sessionUiSnapshot", () => {
  it("restores the focused session's own chips and queued composer state", () => {
    const session = new Session();
    session.chips = [{
      id: "chip-b",
      path: "/repo-b/file.ts",
      relPath: "file.ts",
      hidden: false,
    }];
    session.queuedSends = [{ text: "queued for B", chips: [] }];

    expect(sessionUiSnapshot(session, "plan")).toEqual([
      { type: "modeChanged", modeId: "plan" },
      // AP-15. Replacing state like the mode badge: a focus switch, a reload or
      // a remote attach must put the Session type control back. The id is empty
      // because this session has not been named by a CLI yet — which is exactly
      // the state in which the control is switchable.
      { type: "sessionType", sessionId: "", sessionType: "agent", locked: false },
      { type: "planModeAvailability", available: true, reason: undefined, recheckable: false },
      {
        type: "providerCapabilities",
        provider: "grok",
        capabilities: allProviderCapabilities("grok", {
          planModeAvailable: true,
          cliVerified: true,
          planModeUnavailableReason: undefined,
        }),
      },
      { type: "feedbackAvailability", available: false },
      { type: "chips", chips: session.chips },
      { type: "queuedSends", items: ["queued for B"], queued: [{ text: "queued for B" }] },
    ]);
  });

  it("keeps an old CLI's Plan restriction attached to that session (not recheckable)", () => {
    const session = new Session();
    session.planModeAvailable = false;
    session.planModeVersionVerified = true;
    session.planModeUnavailableReason = "Plan mode requires a newer CLI.";

    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "planModeAvailability",
      available: false,
      reason: "Plan mode requires a newer CLI.",
      recheckable: false,
    });
  });

  it("does not mark an available-but-unverified cache substitute as a disabled recheck row", () => {
    const session = new Session();
    session.planModeAvailable = true;
    session.planModeVersionVerified = false;

    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "planModeAvailability",
      available: true,
      reason: undefined,
      recheckable: false,
    });
  });

  it("marks an unverified Plan probe recheckable so a focus replay keeps the row clickable", () => {
    const session = new Session();
    session.planModeAvailable = false;
    session.planModeVersionVerified = false;
    session.planModeUnavailableReason = "Could not verify the installed Grok CLI version.";

    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "planModeAvailability",
      available: false,
      reason: "Could not verify the installed Grok CLI version.",
      recheckable: true,
    });
  });

  it("re-sends a live crew run after a focus swap (AP-12, R5)", () => {
    const session = new Session();
    session.crewRun = {
      runId: "run-1",
      goal: "Ship",
      cwd: "/r",
      status: "running",
      steps: [{
        index: 1,
        title: "Write it",
        status: "running",
        filesReported: [],
        filesObserved: [],
      }],
    };
    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "crewRun",
      run: session.crewRun,
    });
  });

  it("replays thumbs availability and the live-turn rating after a focus swap", () => {
    const session = new Session();
    session.feedbackAvailable = true;
    session.liveFeedbackEligible = true;
    session.turnRating = -1;
    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "feedbackAvailability",
      available: true,
    });
    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "turnFeedbackAck",
      rating: -1,
    });
  });

  it("does not restore thumbs for a session that has not completed a live turn", () => {
    const session = new Session();
    session.feedbackAvailable = true;
    session.turnRating = 1;
    expect(sessionUiSnapshot(session, "agent")).not.toContainEqual(
      expect.objectContaining({ type: "turnFeedbackAck" }),
    );
  });

  it("accepts locally staged preview URIs for a warm focus snapshot", () => {
    const session = new Session();
    const localChip = {
      id: "image:/staging/a.png:1:1",
      path: "/staging/a.png",
      relPath: "Image #1",
      hidden: false,
      imageIndex: 1,
      mimeType: "image/png",
      previewSrc: "vscode-webview://preview/a.png",
    };
    session.chips = [{ ...localChip, previewSrc: undefined }];

    expect(sessionUiSnapshot(session, "agent", [localChip])).toContainEqual({
      type: "chips",
      chips: [localChip],
    });
  });

  it("restores the review-center list after a focus switch, and omits it when empty", () => {
    const session = new Session();
    expect(sessionUiSnapshot(session, "agent").some((m) => m.type === "reviewCenter")).toBe(false);
    session.userMessageCount = 2;
    session.reviewBlocks = [{
      path: "src/a.ts",
      oldText: "a",
      newText: "b",
      sites: [{ oldText: "a", newText: "b" }],
      toolCallId: "t1",
      turnId: "2",
      status: "completed",
    }];
    expect(sessionUiSnapshot(session, "agent")).toContainEqual(
      expect.objectContaining({ type: "reviewCenter", currentTurnId: "2" }),
    );
  });
});
