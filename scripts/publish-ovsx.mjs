#!/usr/bin/env node
/**
 * Publish the current version's .vsix to Open VSX.
 *
 * Exists because doing this by hand goes wrong the same way every time: `ovsx`
 * wants the token in `OVSX_PAT`, this repo keeps it in `.env` as
 * `OPEN_VSX_API_KEY`, and when it finds neither it opens an interactive prompt
 * — which in a non-interactive shell fails with "User force closed the prompt",
 * a message that says nothing about the actual problem.
 *
 * Marketplace publishing is deliberately NOT here. That is `npm run publish`
 * (vsce), and it is the owner's to run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const vsix = path.join(root, `${pkg.name}-${pkg.version}.vsix`);

if (!existsSync(vsix)) {
  console.error(`No ${path.basename(vsix)} — run \`npm run package\` first.`);
  console.error("Package it from a tree carrying the PRODUCTION relay URL: a .vsix");
  console.error("built by scripts/install.ps1 points at staging by design.");
  process.exit(1);
}

/** `.env` is gitignored and holds the key under this repo's own name. */
function tokenFromEnvFile() {
  const envPath = path.join(root, ".env");
  if (!existsSync(envPath)) return "";
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = /^\s*OPEN_VSX_API_KEY\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return "";
}

const token = process.env.OVSX_PAT || process.env.OPEN_VSX_API_KEY || tokenFromEnvFile();
if (!token) {
  console.error("No Open VSX token. Set OPEN_VSX_API_KEY in .env (or OVSX_PAT in the environment).");
  console.error("Tokens come from https://open-vsx.org/user-settings/tokens");
  process.exit(1);
}

console.log(`Publishing ${path.basename(vsix)} to Open VSX...`);
try {
  // Passed as an argument rather than printed, and never logged.
  execFileSync("npx", ["ovsx", "publish", vsix, "-p", token], {
    stdio: "inherit",
    cwd: root,
    shell: process.platform === "win32",
  });
} catch {
  process.exit(1);
}
