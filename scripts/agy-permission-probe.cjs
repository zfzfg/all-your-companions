/**
 * Diagnostic Probe: Antigravity Headless Permission Behavior (Backlog 9.2a)
 *
 * Tests whether `agy` in headless pipe mode (`--input-format stream-json --output-format stream-json`)
 * emits structured JSON permission confirmation requests over stdio when run WITHOUT
 * `--dangerously-skip-permissions`, or if it fails immediately / blocks waiting for TTY.
 *
 * Usage: node scripts/agy-permission-probe.cjs
 */

const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");

function findAgy() {
  if (process.env.AGY_PATH) return process.env.AGY_PATH;
  if (process.env.GEMINI_CLI_EXECUTABLE) return process.env.GEMINI_CLI_EXECUTABLE;

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(os.homedir(), ".gemini", "bin", "agy.exe"),
    path.join(os.homedir(), ".gemini", "bin", "agy.cmd"),
    path.join(localAppData, "agy", "bin", "agy.exe"),
    path.join(localAppData, "agy", "bin", "agy.cmd"),
    "/usr/local/bin/agy",
    path.join(os.homedir(), ".gemini", "bin", "agy"),
  ];

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["agy"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  if (probe.status === 0 && probe.stdout) {
    const first = probe.stdout.trim().split(/\r?\n/)[0]?.trim();
    if (first) return first;
  }

  return "agy";
}

async function runProbe(agyPath, withSkipPermissions) {
  const label = withSkipPermissions ? "WITH --dangerously-skip-permissions" : "WITHOUT --dangerously-skip-permissions (default)";
  console.log(`\n======================================================`);
  console.log(`Probe: ${label}`);
  console.log(`======================================================`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-perm-probe-"));
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--add-dir", tmpDir,
  ];
  if (withSkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  console.log(`Spawning: ${agyPath} ${args.join(" ")}`);

  const proc = spawn(agyPath, args, {
    cwd: tmpDir,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(agyPath),
    windowsHide: true,
  });

  const stdoutLines = [];
  const stderrLines = [];

  const rlOut = readline.createInterface({ input: proc.stdout });
  rlOut.on("line", (line) => {
    stdoutLines.push(line);
    console.log(`[stdout] ${line}`);
  });

  const rlErr = readline.createInterface({ input: proc.stderr });
  rlErr.on("line", (line) => {
    stderrLines.push(line);
    console.log(`[stderr] ${line}`);
  });

  // Send a prompt asking to run a write or execute command
  const promptMessage = JSON.stringify({
    event: "user",
    message: {
      role: "user",
      content: "Run the command 'echo hello_world' using run_command.",
    },
  }) + "\n";

  await new Promise((resolve) => setTimeout(resolve, 500));
  console.log(`Sending prompt...`);
  proc.stdin.write(promptMessage);

  // Wait for result or timeout
  const exitPromise = new Promise((resolve) => proc.on("exit", (code) => resolve(`exit(${code})`)));
  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve("timeout"), 10000));

  const outcome = await Promise.race([exitPromise, timeoutPromise]);
  console.log(`Outcome after wait: ${outcome}`);

  try {
    proc.stdin.end();
    proc.kill();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  const hasExplicitPermissionDenied = stdoutLines.some((l) => {
    try {
      const parsed = JSON.parse(l);
      const text = JSON.stringify(parsed);
      return /permission check failed|user denied permission|permission denied/i.test(text);
    } catch {
      return false;
    }
  }) || stderrLines.some((l) => /permission denied|permission check failed/i.test(l));

  const hasConfirmationRequest = stdoutLines.some((l) => {
    try {
      const parsed = JSON.parse(l);
      return parsed.event === "permission_request" || parsed.event === "confirmation_request" || parsed.step_update?.tool_name === "ask_permission";
    } catch {
      return false;
    }
  });

  console.log(`Permission denial detected: ${hasExplicitPermissionDenied}`);
  console.log(`Machine-readable confirmation request: ${hasConfirmationRequest}`);

  return {
    withSkipPermissions,
    outcome,
    permissionDenied: hasExplicitPermissionDenied,
    hasConfirmationRequest,
    stdoutLines,
    stderrLines,
  };
}

async function main() {
  const agy = findAgy();
  console.log(`Found Antigravity CLI binary: ${agy}`);

  const helpCheck = spawnSync(agy, ["--help"], {
    encoding: "utf8",
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(agy),
    windowsHide: true,
  });
  const helpText = `${helpCheck.stdout || ""}\n${helpCheck.stderr || ""}`;
  const supportsInput = helpText.includes("--input-format");
  const supportsSkip = helpText.includes("--dangerously-skip-permissions");

  console.log(`Supports --input-format: ${supportsInput}`);
  console.log(`Supports --dangerously-skip-permissions: ${supportsSkip}`);

  if (!supportsInput) {
    console.error("CLI does not support --input-format. Cannot probe NDJSON pipe mode.");
    return;
  }

  // Probe without skip permissions
  const withoutSkip = await runProbe(agy, false);

  // Summary
  console.log(`\n======================================================`);
  console.log(`PROBE SUMMARY (Backlog 9.2a Analysis)`);
  console.log(`======================================================`);
  if (withoutSkip.permissionDenied && !withoutSkip.hasConfirmationRequest) {
    console.log(`RESULT: In headless stream-json mode WITHOUT --dangerously-skip-permissions,`);
    console.log(`agy immediately aborts with permission errors and does NOT emit confirmation events.`);
    console.log(`Recommendation: Keep --dangerously-skip-permissions as default for headless mode.`);
  } else if (withoutSkip.hasConfirmationRequest) {
    console.log(`RESULT: agy emitted structured confirmation events!`);
    console.log(`Interactive permission proxying is viable in headless mode.`);
  } else {
    console.log(`RESULT: Outcome inconclusive. See stdout/stderr logs above.`);
  }
}

main().catch(console.error);
