/**
 * AP-07 Settings → Advanced "Permission rules".
 *
 * Invisible rules are a security problem: the evaluation order is painted,
 * the floor is its own non-deletable list, user rules can be deleted, and a
 * checked-in file shows as pending until adopted.
 */
import { describe, expect, it } from "vitest";
import { Window } from "happy-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PERMISSION_RULES_ORDER_COPY } from "../src/permission-rules";

const settingsSrc = readFileSync(
  fileURLToPath(new URL("../media/settings.js", import.meta.url)),
  "utf8",
);

function boot(opts: {
  permissionRules?: unknown;
  permissionRulesOrderCopy?: string;
  permissionRulesPending?: unknown;
  category?: string;
} = {}) {
  const window = new Window({ url: "https://localhost/" });
  (window as unknown as { eval: (src: string) => void }).eval(settingsSrc);
  const api = (window as unknown as { GrokSettings: Record<string, any> }).GrokSettings;
  const doc = window.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const posted: Array<Record<string, unknown>> = [];
  const env = api.defaultEnv({ isRemote: false, isDesktop: true, providersKnown: true });
  const snapshot = api.defaultSnapshot({
    permissionRules: opts.permissionRules === undefined ? null : opts.permissionRules,
    permissionRulesOrderCopy: opts.permissionRulesOrderCopy || PERMISSION_RULES_ORDER_COPY,
    permissionRulesPending: opts.permissionRulesPending ?? null,
  });
  const surface = api.mount(root, {
    snapshot,
    env,
    standalone: true,
    category: opts.category || "advanced",
    post: (msg: Record<string, unknown>) => posted.push(msg),
  });
  return { api, doc, root, posted, window, surface };
}

const FLOOR = {
  id: "socket-delete-system",
  action: "floor",
  scope: "floor",
  summary: "Delete commands on system paths",
  detail: "rm / del / Remove-Item targeting OS roots.",
  source: "socket",
  deletable: false,
};

const USER = {
  id: "r1",
  action: "allow",
  scope: "workspace",
  summary: "allow execute npm test (workspace)",
  detail: "from card",
  source: "workspace",
  deletable: true,
};

describe("Permission rules settings", () => {
  it("asks the host for the list exactly once on opening Advanced", () => {
    const { posted } = boot({ permissionRules: [FLOOR] });
    expect(posted.filter((m) => m.type === "listPermissionRules")).toHaveLength(1);
  });

  it("paints the evaluation-order sentence, not a tooltip", () => {
    const { root } = boot({ permissionRules: [FLOOR] });
    const order = root.querySelector(".settings-perm-order");
    expect(order?.textContent).toBe(PERMISSION_RULES_ORDER_COPY);
  });

  it("shows a loading state while permissionRules is null", () => {
    const { root } = boot({ permissionRules: null });
    expect(root.querySelector(".settings-perm-state")?.textContent).toMatch(/Loading permission rules/);
  });

  it("the floor has no Delete button; a user rule does", () => {
    const { root, posted } = boot({ permissionRules: [FLOOR, USER] });
    const rows = [...root.querySelectorAll(".settings-perm-row")];
    expect(rows).toHaveLength(2);
    expect(rows[0].classList.contains("is-floor")).toBe(true);
    expect(rows[0].querySelector(".settings-perm-delete")).toBeNull();
    const del = rows[1].querySelector(".settings-perm-delete") as HTMLButtonElement;
    expect(del).toBeTruthy();
    // Two clicks: a deleted rule changes what runs without asking.
    del.click();
    expect(posted.some((m) => m.type === "deletePermissionRule")).toBe(false);
    (root.querySelectorAll(".settings-perm-row")[1].querySelector(".settings-perm-delete") as HTMLButtonElement).click();
    expect(posted).toContainEqual({ type: "deletePermissionRule", id: "r1" });
  });

  it("a pending checked-in file offers Adopt, not silent activation", () => {
    const { root, posted } = boot({
      permissionRules: [FLOOR],
      permissionRulesPending: { path: "/repo/.grok/permissions.json", ruleCount: 2, hash: "abc" },
    });
    expect(root.textContent).toMatch(/not active until you adopt/);
    const adopt = root.querySelector(".settings-perm-adopt") as HTMLButtonElement;
    adopt.click();
    expect(posted).toContainEqual({ type: "adoptPermissionRules", adopt: true });
  });

  it("is listed in Advanced (the security surface is part of this AP)", () => {
    const { api } = boot();
    const row = api.ROWS.find((r: { id: string }) => r.id === "permissionRules");
    expect(row.category).toBe("advanced");
    expect(row.kind).toBe("permissionRules");
  });
});
