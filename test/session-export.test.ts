// Transcript → Markdown renderer. Drives the shipped helper with the same
// host→webview event shapes chat.js records (and the Composer wire fixture
// already used by the subagent replay suite).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { exportSessionMarkdown, exportSessionFilename } from "../media/webview-helpers.js";
import { buildPrompt, buildPromptWithImages } from "../src/prompt-builder";
import { makeExplicitChip, makeImageChip } from "../src/chips";

const deps = {
  readFile: () => "",
  extName: (p: string) => {
    const i = p.lastIndexOf(".");
    return i >= 0 ? p.slice(i) : "";
  },
};

const FIXTURE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "composer-subagent-session.jsonl"),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

function asHostTools() {
  return FIXTURE.map((rec: { sessionUpdate: string }) => ({
    type: rec.sessionUpdate === "tool_call" ? "toolCall" : "toolCallUpdate",
    call: rec,
  }));
}

describe("exportSessionFilename", () => {
  it("keeps a readable name and strips path characters", () => {
    expect(exportSessionFilename("Fix the rewind map")).toBe("Fix the rewind map.md");
    expect(exportSessionFilename("a/b\\c:d*e?.md")).toBe("abcde.md");
    expect(exportSessionFilename("   ")).toBe("conversation.md");
  });
});

describe("exportSessionMarkdown", () => {
  it("attributes user and assistant prose and skips thinking", () => {
    const md = exportSessionMarkdown([
      { type: "userMessage", text: "what does this do?", chips: [] },
      { type: "agentStart" },
      { type: "thoughtChunk", text: "I should look at the file first." },
      { type: "messageChunk", text: "It exports the open conversation." },
      { type: "agentEnd" },
    ], { title: "Export demo" });

    expect(md).toContain("# Export demo");
    expect(md).toContain("## User");
    expect(md).toContain("what does this do?");
    expect(md).toContain("## Assistant");
    expect(md).toContain("It exports the open conversation.");
    expect(md).not.toContain("I should look at the file first.");
    expect(md).not.toMatch(/thinking/i);
  });

  it("peels a real buildPrompt envelope back to the user's words plus attachments", () => {
    const chip = makeExplicitChip("/work/repo/src/sidebar.ts", "src/sidebar.ts");
    const text = buildPrompt("please review this", [chip], deps);
    const md = exportSessionMarkdown([
      { type: "userMessage", text, chips: [chip] },
      { type: "messageChunk", text: "Looks good." },
      { type: "agentEnd" },
    ]);

    expect(md).toContain("please review this");
    expect(md).not.toContain("<vscode-context>");
    expect(md).toContain("Attached: src/sidebar.ts");
  });

  it("names images instead of embedding them", () => {
    const chip = makeImageChip("/tmp/shot.png", 1, "image/png", "shots/shot.png");
    const built = buildPromptWithImages(
      "what is this?",
      [chip],
      [{ index: 1, mimeType: "image/png", data: "aaaa", relPath: "shots/shot.png" }],
      deps,
    );
    const md = exportSessionMarkdown([
      { type: "userMessage", text: built.text, chips: [chip] },
      { type: "media", media: "image", path: "/home/.grok/generated/abc.png" },
      { type: "agentEnd" },
    ]);

    expect(md).toContain("what is this?");
    expect(md).toMatch(/\[Image #1\] \(shot\.png\)/);
    expect(md).toContain("[Image: abc.png]");
    expect(md).not.toContain("aaaa");
    expect(md).not.toMatch(/data:image/);
  });

  it("keeps command + trimmed output as a compact tool block", () => {
    const md = exportSessionMarkdown([
      { type: "userMessage", text: "status please", chips: [] },
      { type: "toolCall", call: { toolCallId: "t1", kind: "execute", title: "git status", rawInput: { command: "git status" } } },
      {
        type: "commandOutput",
        command: "git status",
        output: "On branch main\n\nNo commits yet\n",
        exitCode: 0,
        truncated: false,
      },
      { type: "agentEnd" },
    ]);

    expect(md).toContain("- Run `git status`");
    expect(md).toContain("$ git status");
    expect(md).toContain("On branch main");
  });

  it("renders the Composer fixture tools without omitting activity or dumping thought", () => {
    const md = exportSessionMarkdown([
      { type: "userMessage", text: "demo the subagents", chips: [] },
      ...asHostTools(),
      { type: "messageChunk", text: "Done with the demo." },
      { type: "agentEnd" },
    ], { title: "Subagent demo" });

    expect(md).toContain("## User");
    expect(md).toContain("demo the subagents");
    expect(md).toContain("## Assistant");
    expect(md).toContain("Done with the demo.");
    expect(md).toContain("- Read `c:\\GitHub\\grok-build-vscode\\package.json`");
    expect(md).toContain("- Subagent · Demo subagent file count");
    expect(md).toContain("rootFileCount");
    expect(md).not.toContain("This is the output of the subagent:");
  });

  it("does not present an MCP row as a shell command", () => {
    const mcpIn = JSON.stringify({ message: "MCPSHAPE_9931" }, null, 2);
    const md = exportSessionMarkdown([
      { type: "userMessage", text: "echo please", chips: [] },
      {
        type: "toolCall",
        call: {
          toolCallId: "exec-mcp-1",
          kind: "other",
          title: "mcp.everything.echo",
          rawInput: { server: "everything", tool: "echo", arguments: { message: "MCPSHAPE_9931" } },
          detailInput: mcpIn,
        },
      },
      {
        type: "commandOutput",
        command: mcpIn,
        toolCallId: "exec-mcp-1",
        output: "Echo: MCPSHAPE_9931",
        exitCode: null,
        truncated: false,
        cancelled: false,
      },
      { type: "agentEnd" },
    ]);

    expect(md).toContain("- mcp.everything.echo");
    expect(md).toContain("Echo: MCPSHAPE_9931");
    expect(md).toContain(mcpIn);
    expect(md).not.toMatch(/^- Run `/m);
    expect(md).not.toContain("$ {");
    expect(md).not.toContain("Run `{`");
  });

  it("flattens a historyBatch the same way a remote snapshot arrives", () => {
    const md = exportSessionMarkdown([
      {
        type: "historyBatch",
        messages: [
          { type: "userMessageChunk", text: "batched prompt" },
          { type: "messageChunk", text: "batched answer" },
          { type: "agentEnd" },
        ],
      },
    ]);
    expect(md).toContain("batched prompt");
    expect(md).toContain("batched answer");
  });
});
