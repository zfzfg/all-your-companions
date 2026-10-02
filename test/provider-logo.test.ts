import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("provider logo assets", () => {
  // settings.js carries a third copy because the VS Code settings TAB loads
  // only settings.css + settings.js — it cannot reach a shared helper.
  it.each(["media/chat.js", "media/projects-rail.js", "media/settings.js"])("inlines both currentColor Lobe marks in %s", (file) => {
    const source = read(file);
    expect(source).toContain("Provider marks from Lobe Icons (MIT)");
    expect(source).toContain('viewBox="0 0 24 24" fill="currentColor"');
    expect(source).toContain("M9.27 15.29l7.978-5.897");
    expect(source).toContain("M9.205 8.658v-2.26");
    expect(source).toContain("M4.709 15.955l4.72-2.647.08-.23-.08-.128");
    // Gemini uses the Antigravity arch, not the four-point sparkle. The three
    // copies stay on the same silhouette.
    expect(source).toContain("M20.346 20.774C21.488 21.631");
    expect(source).not.toContain("M12 0C12 6.627");
    const providerSvgs = source.match(/<svg class="provider-logo"[^>]*>/g) ?? [];
    expect(providerSvgs.length).toBeGreaterThan(0);
    expect(providerSvgs.every((svg) => !svg.includes("style="))).toBe(true);
  });

  it.each(["media/chat.css", "media/projects-rail.css"])("maps every badge state and draws the one-pixel row-color ring in %s", (file) => {
    const css = read(file);
    for (const state of ["working", "needs-you", "unread", "error"]) {
      expect(css).toContain(`provider-status-badge${file.endsWith("chat.css") ? `.dot-${state}` : `[data-dot="${state}"]`}`);
    }
    expect(css).toMatch(/\.provider-status-badge\s*\{[\s\S]*?width:\s*4px;[\s\S]*?height:\s*4px;/);
    expect(css).toContain("box-shadow: 0 0 0 1px var(--provider-badge-ring");
  });
});
