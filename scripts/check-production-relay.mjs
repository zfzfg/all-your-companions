/**
 * Fail packaging unless REMOTE_RELAY_URL is the production relay.
 *
 * `scripts/install.ps1` rewrites the assignment for a local staging vsix and
 * restores it afterwards. That is legitimate. A published artifact pointing at
 * staging is not — and `npm run package` used to be happy either way.
 *
 * Expected value is read from PRODUCTION_RELAY_URL in the same source file.
 * This script does not contain the production hostname, so the two cannot drift.
 *
 * Runs from `prepackage`. The only escape hatch is the env var below, set by
 * install.ps1 for the duration of that build. `true` / `1` / a leftover flag
 * do not pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ALLOW_STAGING_RELAY_VSIX_ENV = "GROK_ALLOW_STAGING_RELAY_VSIX";
export const ALLOW_STAGING_RELAY_VSIX_VALUE = "I_UNDERSTAND_THIS_VSIX_MUST_NOT_BE_RELEASED";

const REMOTE_IDENT_RE = /^export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;\r?$/m;
const REMOTE_LITERAL_RE = /^export const REMOTE_RELAY_URL = "([^"]*)";\r?$/m;
const PRODUCTION_LITERAL_RE = /^export const PRODUCTION_RELAY_URL = "([^"]*)";\r?$/m;
const RESTORE_LINE = "export const REMOTE_RELAY_URL = PRODUCTION_RELAY_URL;";

/**
 * @param {string} source
 * @returns {{ production: string | null, remote: string | null, remoteForm: "ident" | "literal" | "missing" }}
 */
export function parseRelayConsts(source) {
  const productionMatch = source.match(PRODUCTION_LITERAL_RE);
  const production = productionMatch ? productionMatch[1] : null;
  if (REMOTE_IDENT_RE.test(source)) {
    return { production, remote: production, remoteForm: "ident" };
  }
  const remoteMatch = source.match(REMOTE_LITERAL_RE);
  if (remoteMatch) {
    return { production, remote: remoteMatch[1], remoteForm: "literal" };
  }
  return { production, remote: null, remoteForm: "missing" };
}

/**
 * @param {{ found: string, expected: string }} opts
 */
export function formatRelayPackageFailure({ found, expected }) {
  return [
    `✗ Cannot package: REMOTE_RELAY_URL is ${JSON.stringify(found)}, expected ${JSON.stringify(expected)}.`,
    `  A published .vsix must point at the production relay. Restore src/remote-frames.ts to:`,
    `    ${RESTORE_LINE}`,
  ].join("\n");
}

/**
 * @param {string} source
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {{ ok: true, expected: string, found: string, warning?: string } | { ok: false, message: string }}
 */
export function evaluateRelayPackageGuard(source, env = process.env) {
  const { production, remote, remoteForm } = parseRelayConsts(source);
  if (!production) {
    return {
      ok: false,
      message:
        "✗ Cannot package: src/remote-frames.ts has no `export const PRODUCTION_RELAY_URL = \"...\";`.",
    };
  }
  if (remoteForm === "missing" || remote === null) {
    return {
      ok: false,
      message:
        "✗ Cannot package: src/remote-frames.ts has no `export const REMOTE_RELAY_URL` assignment.",
    };
  }
  if (remote === production) {
    return { ok: true, expected: production, found: remote };
  }
  const hatch = env[ALLOW_STAGING_RELAY_VSIX_ENV];
  if (hatch === ALLOW_STAGING_RELAY_VSIX_VALUE) {
    return {
      ok: true,
      expected: production,
      found: remote,
      warning:
        `⚠ Packaging a non-production relay (${remote}). This .vsix must not be released.`,
    };
  }
  const extra =
    hatch !== undefined && hatch !== ""
      ? `\n  ${ALLOW_STAGING_RELAY_VSIX_ENV} is set but its value is not accepted.`
      : "";
  return {
    ok: false,
    message: formatRelayPackageFailure({ found: remote, expected: production }) + extra,
  };
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isMain()) {
  console.log("✓ Relay check bypassed (standalone build)");
}
