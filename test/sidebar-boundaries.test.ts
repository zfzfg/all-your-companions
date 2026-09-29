import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { GrokSidebar } from "../src/sidebar";

const modules = readdirSync(new URL("../src/", import.meta.url)).filter((name) =>
  /(?:-host|sidebar-inbound|session-start|session-catalog|provider-session|provider-setup|agent-authoring|turn-edit|voice-and-mcp|project-folders|routine-scheduler|implicit-context|workflow-stage-runner|webview-html)\.ts$/.test(name),
);

const program = ts.createProgram(modules.map((name) => fileURLToPath(new URL(`../src/${name}`, import.meta.url))), { target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true });
const checker = program.getTypeChecker();

describe("sidebar collaborator boundaries", () => {
  for (const file of modules) {
    it(`${file} keeps dependency and operations interfaces at or under 25 members`, () => {
      const parsed = program.getSourceFile(fileURLToPath(new URL(`../src/${file}`, import.meta.url)))!;
      for (const declaration of parsed.statements) {
        if (ts.isInterfaceDeclaration(declaration) && /(?:Deps|Ops)(?:State|Actions)?$/.test(declaration.name.text)) {
          expect(declaration.members.length, declaration.name.text).toBeLessThanOrEqual(25);
          const type = checker.getTypeAtLocation(declaration);
          expect(type.getProperties().length, `${declaration.name.text} including inherited members`).toBeLessThanOrEqual(25);
        }
      }
    });
  }
});


describe("sidebar delegation lifetime", () => {
  it("does not construct unused collaborators while disposing a cold sidebar", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.host = { setContext: vi.fn() };
    sidebar.pool = new Set();
    sidebar.terminalManager = { disposeAll: vi.fn() };
    const factories = ["createSessionCatalog", "createSidebarViewHost", "createFileUploadHost", "createImplicitContext", "createVoiceAndMcp", "createProviderSetup", "createSessionStart"];
    for (const name of factories) sidebar[name] = vi.fn(() => { throw new Error(name); });
    sidebar.dispose();
    for (const name of factories) expect(sidebar[name]).not.toHaveBeenCalled();
  });
  it("supports a call-through spy without a recursive delegation loop", () => {
    const sidebar = Object.create(GrokSidebar.prototype) as any;
    sidebar.host = { showWarningMessage: vi.fn() };
    const spy = vi.spyOn(sidebar, "notifyUser");
    sidebar.notifyUser("warning", "message");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(sidebar.host.showWarningMessage).toHaveBeenCalledWith("message");
  });
});
