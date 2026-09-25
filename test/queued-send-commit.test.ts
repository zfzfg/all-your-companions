import { describe, expect, it } from "vitest";
import {
  Session,
  beginQueuedSendCommit,
  finishQueuedSendCommit,
} from "../src/session";
import { enqueueQueuedSend } from "../src/queued-send";
import { makeImageChip } from "../src/chips";

const item = (text: string, chips: Session["queuedSends"][number]["chips"] = []) => ({ text, chips });

describe("queued send commit", () => {
  it("retains a queued send when the send does not commit", () => {
    const session = new Session();
    session.queuedSends = [item("do not lose this")];

    const claim = beginQueuedSendCommit(session, "do not lose this")!;
    expect(finishQueuedSendCommit(session, claim, false)).toBe(false);
    expect(session.queuedSends).toEqual([item("do not lose this")]);
  });

  it("releases a queued send exactly once when the send commits", () => {
    const session = new Session();
    session.queuedSends = [item("run this once")];

    const claim = beginQueuedSendCommit(session, "run this once")!;
    expect(finishQueuedSendCommit(session, claim, true)).toBe(true);
    expect(session.queuedSends).toEqual([]);
    expect(finishQueuedSendCommit(session, claim, true)).toBe(false);
  });

  it("keeps a contribution appended while a failing send is awaiting commit", () => {
    const session = new Session();
    session.queuedSends = [item("first part")];

    const claim = beginQueuedSendCommit(session, "first part")!;
    session.queuedSends = enqueueQueuedSend(session.queuedSends, "second part", []);
    expect(finishQueuedSendCommit(session, claim, false)).toBe(false);
    expect(session.queuedSends).toEqual([item("first part"), item("second part")]);
  });

  it("releases only the committed prefix when a contribution was appended in flight", () => {
    const session = new Session();
    session.queuedSends = [item("first part")];

    const claim = beginQueuedSendCommit(session, "first part")!;
    session.queuedSends = enqueueQueuedSend(session.queuedSends, "second part", []);
    expect(finishQueuedSendCommit(session, claim, true)).toBe(true);
    expect(session.queuedSends).toEqual([item("second part")]);
  });

  it("keeps each contribution's chips with the prefix that owns them", () => {
    const session = new Session();
    const a = makeImageChip("/s/a.png", 1, "image/png");
    const b = makeImageChip("/s/b.png", 2, "image/png");
    session.queuedSends = [item("look at A", [a]), item("edit [Image #2]", [b])];

    const claim = beginQueuedSendCommit(session, "look at A")!;
    expect(claim.items[0].chips).toEqual([a]);
    expect(finishQueuedSendCommit(session, claim, true)).toBe(true);
    expect(session.queuedSends).toEqual([item("edit [Image #2]", [b])]);
    expect((session.queuedSends[0].chips[0] as any).imageIndex).toBe(2);
  });

  it("commits an image-only prefix after a later contribution is appended in flight", () => {
    const session = new Session();
    const image = makeImageChip("/s/only.png", 1, "image/png");
    session.queuedSends = [item("", [image])];

    const claim = beginQueuedSendCommit(session, "")!;
    expect(claim).toBeDefined();
    session.queuedSends = enqueueQueuedSend(session.queuedSends, "later", []);
    expect(finishQueuedSendCommit(session, claim, true)).toBe(true);
    expect(session.queuedSends).toEqual([item("later")]);
  });
});
