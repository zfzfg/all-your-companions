import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const buildOptions = {
  entryPoints: {
    extension: path.join(root, "src/extension.ts"),
    "agy-acp-adapter": path.join(root, "src/agy-acp-adapter.ts"),
  },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  sourcemap: true,
  outdir: path.join(root, "out"),
  external: [
    "vscode",
    "@agentclientprotocol/codex-acp",
    "@agentclientprotocol/claude-agent-acp",
    "@anthropic-ai/claude-agent-sdk",
    "@muse-code/sdk",
  ],
  logLevel: "info",
};

if (isWatch) {
  const ctx = await esbuild.context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
}
