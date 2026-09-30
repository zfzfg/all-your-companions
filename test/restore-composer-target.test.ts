import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A rewound message goes back to the conversation it came from, and no other.
 *
 * `restoreComposer` APPENDS to whatever is already typed (media/chat.js case
 * "restoreComposer") — deliberately, because silently destroying a draft is the
 * bug Edit exists to fix. The rewind RPC is asynchronous, so by the time it
 * returns the view may show another conversation; pasting there would put
 * conversation A's text into conversation B's composer.
 *
 * A source-shape guard, and honest about it: it proves the rewind and edit
 * paths route through the focus-checking helper rather than the session-wide
 * emit, not that a frame reaches one view and not another.
 */
const src = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "sidebar.ts"),
  "utf8",
);
const turnEditSrc = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "turn-edit.ts"),
  "utf8",
);

function methodBody(signature: string): string {
  const isTurnEditMethod = signature.includes("editLastMessage") || signature.includes("rewindFocusedSession");
  const targetSrc = isTurnEditMethod ? turnEditSrc : src;
  const bare = signature.replace(/^(?:private|public)\s+/, "");
  const targetSig = isTurnEditMethod ? bare : signature;
  const start = targetSrc.indexOf(targetSig);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  const end = targetSrc.indexOf("\n  private ", start + 1);
  const endPub = targetSrc.indexOf("\n  public ", start + 1);
  const effectiveEnd = end === -1 ? endPub : (endPub === -1 ? end : Math.min(end, endPub));
  return targetSrc.slice(start, effectiveEnd === -1 ? undefined : effectiveEnd);
}

describe("who receives a rewound message", () => {
  it("delivers to the webview when it still shows the conversation", () => {
    const body = methodBody("private restoreComposerFor(");
    expect(body).toContain("this.postLocal(message)");
  });

  /**
   * Without the focus check, conversation A's message lands in conversation
   * B — a different repository's — when the user switches conversation while
   * the rewind RPC is still running.
   */
  it("refuses to deliver to a view that has moved to another conversation", () => {
    const body = methodBody("private restoreComposerFor(");
    expect(body).toContain("this.focused === session");
  });

  /**
   * And refusing is only half an answer. The rewind has already removed the
   * message from the transcript, so a surface that moved on must not simply
   * drop the text — that loses it from both places at once. It is parked on the
   * conversation it belongs to and handed back when that conversation is next
   * on screen.
   */
  it("parks the text on its conversation rather than dropping it", () => {
    const body = methodBody("private restoreComposerFor(");
    expect(body).toContain("queuedDraft: parked");
  });

  /**
   * The slot holds one string. Two rewinds parked before either is collected
   * would overwrite — and the first message is already gone from the transcript,
   * so replacing loses it outright. The webview appends for the same reason;
   * the store must not be the one place that silently drops a message.
   */
  it("appends to an already-parked draft instead of replacing it", () => {
    const body = methodBody("private restoreComposerFor(");
    expect(body).toContain("?.queuedDraft");
    expect(body).toContain("parked ? `${parked}\\n\\n${text}` : text");
  });

  /**
   * And the re-focus paths deliberately do NOT hand it back.
   *
   * `restorePersistedDraft` delivers with session-wide `emit`, so calling it
   * from a re-focus appends the parked text to every surface viewing the
   * conversation — recreating, at the moment you switch back, exactly the
   * desk-composer pollution this sequence removed. Four review rounds went into
   * who receives this text; the settled answer is that parked text returns on
   * the conversation's next LOAD, not the instant it is re-focused. A narrower
   * promise, kept.
   */
  it("does not hand a parked draft back on re-focus, because that path broadcasts", () => {
    for (const signature of ["private focusSession("]) {
      expect(methodBody(signature), signature).not.toContain("this.restorePersistedDraft(session)");
    }
  });

  it("is how both rewind and edit hand the text back", () => {
    for (const signature of ["private async editLastMessage(", "async rewindFocusedSession("]) {
      const body = methodBody(signature);
      // The session travels with it: the helper refuses a surface that has
      // since moved to another conversation, and cannot check that without it.
      expect(body, signature).toContain("this.restoreComposerFor(session,");
      // The session-wide emit is what pasted into a bystander's composer.
      expect(body, signature).not.toContain('emit(session, { type: "restoreComposer"');
    }
  });

  it("leaves the draft-restore paths alone — those are the desk's own drafts", () => {
    // `restoreComposer` with a stored draft is a different flow (a session's own
    // saved text coming back to it) and is not requester-scoped.
    expect(src).toContain('this.emit(session, { type: "restoreComposer", text: draft });');
  });
});
