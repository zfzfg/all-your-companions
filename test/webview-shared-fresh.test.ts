import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { HOST_MESSAGE_TYPES, filterCommands, contextChipLabel, queuedSendsText } from "../src/webview-shared";
import helpers from "../media/webview-helpers.js";

const exec = promisify(execFile);
describe("generated webview shared helpers", () => {
  it("is byte-for-byte fresh and bundles only source with no external imports", async () => {
    const result = await exec(process.execPath, ["scripts/build.mjs", "--check-shared"], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    });
    expect(result.stderr).toBe("");
  });
  it("keeps the CommonJS compatibility API and shared behavior", () => {
    expect(helpers.HOST_MESSAGE_TYPES).toEqual(HOST_MESSAGE_TYPES);
    const commands = [{name: "skill", description: "testing"}, {name: "test"}];
    expect(helpers.filterCommands(commands, "test")).toEqual(filterCommands(commands, "test"));
    const chip = {kind: "terminal" as const, id: "t", hidden: false, relPath: "terminal", label: "bash", bytes: 1024};
    expect(helpers.contextChipLabel(chip)).toBe(contextChipLabel(chip));
    const entries = [{text: "one"}, {text: ""}, {text: "two"}];
    expect(helpers.queuedSendsText(entries)).toBe(queuedSendsText(entries));
  });
});
