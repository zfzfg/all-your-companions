import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const modules = readdirSync(new URL("../src/", import.meta.url)).filter((name) =>
  /(?:-host|sidebar-inbound|session-start|session-catalog|provider-session|provider-setup|agent-authoring|turn-edit|voice-and-mcp|project-folders|routine-scheduler|implicit-context)\.ts$/.test(name),
);

describe("sidebar collaborator boundaries", () => {
  for (const file of modules) {
    it(`${file} keeps dependency and operations interfaces at or under 25 members`, () => {
      const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      for (const declaration of parsed.statements) {
        if (ts.isInterfaceDeclaration(declaration) && /(?:Deps|Ops)$/.test(declaration.name.text)) {
          expect(declaration.members.length, declaration.name.text).toBeLessThanOrEqual(25);
        }
      }
    });
  }
});
