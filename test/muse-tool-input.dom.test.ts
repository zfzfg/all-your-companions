import { expect, it, vi } from "vitest";
import { Approvals } from "../adapters/muse/approvals.mts";
import { Projection } from "../adapters/muse/projection.mts";
import { bootWebview, dispatch } from "./webview-harness";

it("shows Muse's JSON command in the tool row and the actual Allow/Deny card", () => {
  const h = bootWebview();
  const command = 'echo "approval target"';
  try {
    new Projection(call => dispatch(h.window, { type: "toolCall", call } as any), () => {})
      .accept("item/started", { item: { itemId: "tool", callId: "call", kind: "toolCall", tool: "bash",
        revision: 1, status: "inProgress", args: JSON.stringify({ command }) } });
    new Approvals(req => {
      dispatch(h.window, { type: "permissionRequest", req: { ...req, id: 1 } } as any);
      return new Promise(() => {});
    }, vi.fn(), vi.fn(), vi.fn()).accept("approval/requested", {
      sessionId: "session", approvalId: "approval", toolCallId: "call", toolName: "bash",
      rawArgs: JSON.stringify({ command }), currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
      availableChoices: [
        { choiceId: "allow", label: "Allow", scope: "once", decision: "approved" },
        { choiceId: "deny", label: "Deny", scope: "once", decision: "denied" },
      ],
    });
    expect({ tool: h.doc.querySelector(".tool-flat .tool-cmd")?.textContent,
      permission: h.doc.querySelector(".card.permission .command-card-title")?.textContent,
      choices: [...h.doc.querySelectorAll(".card.permission .card-actions button")].map(el => el.textContent),
    }).toEqual({ tool: command, permission: command, choices: ["Allow (once)", "Deny (once)"] });
  } finally { h.window.happyDOM.abort(); }
});
