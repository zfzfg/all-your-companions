import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { checkEsmPackageGraph } from "../scripts/check-esm-package-graph.mjs";

it("checks the spawned entry, relative ESM imports, and the actual imported dependency entry", () => {
  const root = mkdtempSync(path.join(tmpdir(), "muse-packaging-"));
  const files: Record<string, string> = {
    "out/muse-adapter/main.mjs": 'import "./session.mjs";',
    "out/muse-adapter/session.mjs": 'import { connect } from "@muse-code/sdk";',
    "node_modules/@muse-code/sdk/package.json": JSON.stringify({ type: "module", main: "dist/src/index.js" }),
    "node_modules/@muse-code/sdk/dist/src/index.js": 'export { connect } from "./connection.js";',
    "node_modules/@muse-code/sdk/dist/src/connection.js": 'import "node:stream"; export const connect = () => {};',
  };
  try {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), text);
    }
    const packed = Object.keys(files);
    const entry = [packed[0]];
    expect(checkEsmPackageGraph(root, packed, entry)).toEqual([]);
    for (const removed of packed) {
      expect(checkEsmPackageGraph(root, packed.filter(file => file !== removed), entry).join("\n"))
        .toContain("NOT packed");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
