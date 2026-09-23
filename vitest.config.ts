import { cpus } from "node:os";
import { defineConfig } from "vitest/config";

// Leave the machine some headroom (upstream): one worker per core starved the
// reporter, and what that produced was a test file that never reported at all.
const WORKERS = Math.max(2, Math.floor(cpus().length * 0.75));

export default defineConfig({
  test: {
    maxWorkers: WORKERS,
    minWorkers: 1,
    // Every collected file must end in pass, fail or skip: "216 of 217" is not
    // 216 passed and 1 failed, and a gate that can drop a file silently is not
    // a gate (test-support/complete-accounting.mjs).
    reporters: ["default", "./test-support/complete-accounting.mjs"],
    include: ["test/**/*.test.ts"],
    // Electron e2e lives under test/desktop and needs a real BrowserWindow —
    // run via `npm run test:desktop` only (not npm test / CI unit job).
    exclude: ["**/node_modules/**", "**/dist/**", "test/desktop/**"],
    environment: "node",
    // Vitest's 5s default is a hang detector for pure functions; several files
    // here spawn a real shell or a real Node ACP process, and the suite runs one
    // worker per core (20 on the dev box) so those starts contend. That made
    // `npm test` fail 3-4 tests per run with a different set each time, all
    // passing on re-run, while `--no-file-parallelism` was fully green.
    // Raising the ceiling costs nothing when tests pass and still fails a true
    // hang quickly. Deliberately NOT solved with retries: a retry would also
    // hide a genuine 1-in-5 race, which is exactly the class of bug this
    // codebase keeps finding.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
