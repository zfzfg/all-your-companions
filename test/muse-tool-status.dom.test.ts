import { expect, it } from "vitest";
import { Projection } from "../adapters/muse/projection.mts";
import { bootWebview, dispatch } from "./webview-harness";

it.each(["rejected", "timedOut", "futureStatus"])("renders Muse %s as terminal with its reported outcome", status => {
  const h = bootWebview();
  try {
    const p = new Projection(call => dispatch(h.window, {
      type: call.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate", call,
    } as any), () => {});
    const item = { itemId: "tool", kind: "toolCall", tool: "bash", revision: 1, status: "inProgress" };
    p.accept("item/started", { item });
    p.accept("item/completed", { item: { ...item, revision: 2, status } });
    dispatch(h.window, { type: "messageChunk", text: "Turn ended" } as any);
    expect({ running: h.doc.querySelector(".tool-group.in-progress"),
      outcome: h.doc.querySelector(".tool-flat .tool-error")?.textContent })
      .toEqual({ running: null, outcome: `Muse tool ended with status: ${status}` });
  } finally { h.window.happyDOM.abort(); }
});
