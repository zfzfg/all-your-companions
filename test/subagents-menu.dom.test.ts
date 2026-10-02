import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

describe("Subagents menu", () => {
  it.each(["off", "ask", "auto", "read-only-auto"])("selects %s and waits for host confirmation", value => {
    const h = bootWebview();
    dispatch(h.window, { type: "sessionType", sessionId: "s", sessionType: "agent", locked: true });
    dispatch(h.window, { type: "sessionDelegation", value: "auto" } as never);
    const button = h.doc.getElementById("delegation-switch")!;
    click(h.window, button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 24 24");
    click(h.window, h.doc.querySelector(`#subagents-popover [data-value="${value}"]`)!);
    expect(h.posted.at(-1)).toEqual({ type: "setSessionDelegation", value });
    expect(button.textContent).toBe("Auto");
    expect(h.doc.activeElement).toBe(button);
    dispatch(h.window, { type: "sessionDelegation", value } as never);
    click(h.window, button);
    expect(h.doc.querySelector('#subagents-popover [aria-checked="true"]')?.getAttribute("data-value")).toBe(value);
  });

  it("supports arrows, Escape, outside clicks and restart hints", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "sessionType", sessionId: "s", sessionType: "agent", locked: true });
    dispatch(h.window, { type: "sessionDelegation", value: "auto", needsRestart: true } as never);
    const button = h.doc.getElementById("delegation-switch")!;
    const menu = h.doc.getElementById("subagents-popover")!;
    const key = (value: string) => h.doc.activeElement!.dispatchEvent(new h.window.KeyboardEvent("keydown", { key: value, bubbles: true }));
    button.focus(); key("ArrowDown");
    expect(menu.hidden).toBe(false);
    expect(menu.textContent).toContain("next start");
    key("Home"); expect(h.doc.activeElement?.getAttribute("data-value")).toBe("off");
    key("ArrowUp"); expect(h.doc.activeElement?.getAttribute("data-value")).toBe("read-only-auto");
    key("Escape"); expect(menu.hidden).toBe(true); expect(h.doc.activeElement).toBe(button);
    click(h.window, button); click(h.window, h.doc.getElementById("input")!);
    expect(menu.hidden).toBe(true);
    dispatch(h.window, { type: "sessionType", sessionId: "s", sessionType: "crew", locked: true });
    expect(h.doc.getElementById("delegation-switch")).toBeNull();
    dispatch(h.window, { type: "sessionType", sessionId: "s", sessionType: "agent", locked: true });
    expect(h.doc.getElementById("delegation-switch")).not.toBeNull();
    dispatch(h.window, { type: "session", sessionId: "other", provider: "claude", models: [] });
    expect(h.doc.getElementById("delegation-switch")).toBeNull();
  });
});
