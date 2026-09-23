/**
 * What counts as evidence that an account works.
 *
 * The needs-login flag is raised by a refused prompt — an authenticated call
 * the account declined. It was being LOWERED by two things that never touch a
 * credential at all, and the composer's sign-in card is what made that visible:
 * it appeared when the send failed and vanished a moment later, so the one
 * screen offering a way out flickered.
 *
 * Both were measured on the owner's cloud host on 2026-09-14 rather than
 * reasoned about:
 *
 *   10:05:27  [auth] recoverable token error — reloading session + resending
 *   10:05:27  [session/create] phase=validate-cwd … phase=register
 *   10:05:28  [session/load]   phase=session-ready … phase=replay
 *   ——— the prompt that followed answered "Authentication required" ———
 *
 *   10:05:40  [remote] relay clients: 1
 *   10:05:41  spawning …/claude-agent-acp (cwd=…/aiprototypingtest)
 *   10:05:41  spawning …/claude-agent-acp (cwd=…/My First Project)
 *   10:05:41  spawning …/claude-agent-acp (cwd=…/Test)
 *   ——— every listing succeeded, against the same dead token ———
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");
const between = (from: string, to: string) => {
  const start = source.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe("only an accepted credential says an account works", () => {
  // A process that started and replayed a transcript has proved that a binary
  // runs and that a file is readable. Neither is the account.
  it("a session that starts is not an account that authenticates", () => {
    const startSession = between("this.reapPool();", "this.emit(session, { type: \"setBusy\", value: false });");
    expect(startSession).not.toContain("setProviderNeedsLogin(session.provider, false)");
  });

  // Listing reads this machine's own files. A phone reconnect sweeps every
  // project folder, so treating a listing as proof meant the flag could not
  // survive a reconnect — the exact moment a phone user is looking.
  it("a session listing that succeeds is evidence of nothing", () => {
    const listing = between("private async refreshAdapterHistory", "private buildGrokSessionsList");
    expect(listing).not.toContain("this.setProviderNeedsLogin(provider, false)");
  });

  // The other half of the same call site: a listing REFUSED on credentials is
  // a real observation and still raises the flag.
  it("a session listing that is refused on credentials still raises it", () => {
    const schedule = between("private scheduleAdapterHistoryRefresh", "private async refreshCodexHistory");
    expect(schedule).toContain("this.setProviderNeedsLogin(provider, true)");
  });

  it("a served turn is what lowers it", () => {
    const clean = between("session.authRecoveryTried = false; // a clean turn", "this.maybeGenerateTitle(session);");
    expect(clean).toContain("this.setProviderNeedsLogin(session.provider, false)");
  });

  it("and so is a resend the fresh token got through", () => {
    const recovered = between("session.authRecoveryTried = false; // recovered", "this.maybeGenerateTitle(session);");
    expect(recovered).toContain("this.setProviderNeedsLogin(session.provider, false)");
  });

  // The explicit probe keeps its clear: it exists to observe a credential and
  // is what makes a completed sign-in visible without sending anything (#146).
  it("the explicit re-probe still gets to say so", () => {
    const probe = between("private async reprobeProviderCredentials", "The remote half of connecting");
    expect(probe).toContain("this.setProviderNeedsLogin(\"grok\", false)");
  });

  // And so does a device sign-in the app itself calls verified. Claude's check
  // is `probeClaudeAuthStatus`, which answers without going through the probe
  // that clears -- so a phone sign-in ended with the account still flagged, the
  // card back, and (because the flag is what re-arms recovery) the next send
  // reusing the process built on the dead token. A refresh does not fix that;
  // the listing clear this file removes is what used to hide it.
  it("a device sign-in it calls verified gets to say so too", () => {
    const confirm = between("private async confirmDeviceLoginInner", "await this.setProviderConnected(provider, true)");
    expect(confirm).toContain("device login: credential verified");
    expect(confirm).toContain("this.setProviderNeedsLogin(provider, false)");
  });
});
