/**
 * AP-07 "Always allow for…" on the permission card.
 *
 * Suggestions sit outside `.card-actions` so the existing two-button tests
 * stay byte-identical when the host sends none.
 */
import { describe, expect, it } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

const OPTIONS = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

describe("permission card rule suggestions", () => {
  it("does not add a third card-actions button when the host sends none", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 11,
        toolCall: { toolCallId: "t", kind: "execute", title: "npm test" },
        options: OPTIONS,
      },
    });
    const actions = [...doc.querySelectorAll(".card.permission .card-actions button")]
      .map((b) => b.textContent);
    expect(actions).toEqual(["Allow once", "Reject"]);
    expect(doc.querySelector(".perm-rule-suggestions")).toBeNull();
  });

  it("posts permissionAnswer with the suggestion match and allow_once", () => {
    const { window, posted, doc } = bootWebview();
    dispatch(window, {
      type: "permissionRequest",
      req: {
        id: 12,
        toolCall: { toolCallId: "t", kind: "execute", title: "npm test --watch" },
        options: OPTIONS,
      },
      ruleSuggestions: [
        { id: "cmd-two", label: "npm test", match: { kind: "execute", commandPrefix: "npm test" }, scope: "workspace" },
        { id: "cmd-head", label: "npm *", match: { kind: "execute", commandPrefix: "npm" }, scope: "workspace" },
      ],
    });
    expect(doc.querySelector(".perm-rule-suggestions-label")?.textContent).toBe("Always allow — saved as a rule");
    const sug = [...doc.querySelectorAll(".perm-rule-suggestion-label")].map((b) => b.textContent);
    // Where each rule would be written is on the button, not implied.
    expect([...doc.querySelectorAll(".perm-rule-suggestion .cx-pill")].map((b) => b.textContent)).toEqual(["this project", "this project"]);
    expect(sug).toEqual(["npm test", "npm *"]);
    (doc.querySelector(".perm-rule-suggestion") as HTMLButtonElement).click();
    expect(posted).toContainEqual({
      type: "permissionAnswer",
      requestId: 12,
      optionId: "once",
      rule: { kind: "execute", commandPrefix: "npm test" },
    });
  });
});
