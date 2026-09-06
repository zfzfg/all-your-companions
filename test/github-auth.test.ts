import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  DISCONNECTED_GITHUB,
  GITHUB_API_USER_ARGS,
  GITHUB_AUTH_LOGIN_WITH_TOKEN_ARGS,
  GITHUB_REPO_LIST_ARGS,
  GITHUB_REPO_LIST_LIMIT,
  MAX_GITHUB_TOKEN_CHARS,
  githubAuthDescription,
  githubEnvTokenBlocksPasteMessage,
  githubEnvTokenBrokenMessage,
  githubEnvTokenName,
  githubLogoutArgs,
  listGithubRepositories,
  loginGithubWithToken,
  logoutGithub,
  parseGithubApiLogin,
  parseGithubRepoList,
  readGithubAuthState,
  redactGithubSecret,
  type GithubAuthIo,
  GITHUB_AUTH_SETUP_GIT_ARGS,
} from "../src/github-auth";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    writes: [] as string[],
    write(chunk: string) { this.writes.push(String(chunk)); return true; },
    end() { /* */ },
  };
  killed: string[] = [];
  kill(signal?: string) {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }
}

/**
 * gh 2.79.0: `auth status --json` is unknown; `api user --jq .login` and
 * `repo list --json` work. Every execFile seam in this file goes through
 * this so a regression onto the newer flag fails here, not on a cloud box.
 */
function execIo(handler: (args: unknown[], cb: Function) => void): GithubAuthIo {
  return {
    execFile: ((...rest: unknown[]) => {
      const cb = rest[rest.length - 1] as Function;
      const argv = Array.isArray(rest[1]) ? (rest[1] as unknown[]).map(String) : [];
      if (argv[0] === "auth" && argv[1] === "status" && argv.includes("--json")) {
        cb(
          Object.assign(new Error("unknown flag: --json"), { code: 1 }),
          "",
          "unknown flag: --json\n\nUsage:  gh auth status [flags]",
        );
        return;
      }
      handler(rest, cb);
    }) as GithubAuthIo["execFile"],
    spawn: vi.fn() as unknown as GithubAuthIo["spawn"],
  };
}

describe("parseGithubApiLogin", () => {
  it("takes the first line of a successful api user", () => {
    expect(parseGithubApiLogin("phuryn\n")).toBe("phuryn");
    expect(parseGithubApiLogin("")).toBe("");
  });

  it("refuses JSON-shaped stdout so a failed call cannot look like a login", () => {
    expect(parseGithubApiLogin('{"message":"Bad credentials"}')).toBe("");
    expect(parseGithubApiLogin("{")).toBe("");
  });
});

describe("githubEnvTokenName", () => {
  it("reports presence, never the value, and prefers GH_TOKEN", () => {
    expect(githubEnvTokenName({})).toBeUndefined();
    expect(githubEnvTokenName({ GH_TOKEN: "secret-a", GITHUB_TOKEN: "secret-b" })).toBe("GH_TOKEN");
    expect(githubEnvTokenName({ GITHUB_TOKEN: "secret-b" })).toBe("GITHUB_TOKEN");
    expect(JSON.stringify(githubEnvTokenName({ GH_TOKEN: "secret-a" }))).not.toContain("secret");
  });
});

describe("githubAuthDescription", () => {
  it("names a working login without a credential-source label", () => {
    expect(githubAuthDescription({
      connected: true, login: "phuryn", envTokenInForce: false, error: false, cliPresent: true,
    })).toBe("Signed in as @phuryn.");
    expect(githubAuthDescription({
      connected: false, login: "", envTokenInForce: false, error: false, cliPresent: true,
    })).toMatch(/Connect GitHub/);
  });

  it("names a broken env token instead of a bare not-connected", () => {
    expect(githubAuthDescription({
      connected: false, login: "", envTokenInForce: true, error: true, cliPresent: true,
      message: githubEnvTokenBrokenMessage("GH_TOKEN"),
    })).toBe("A token in this machine's GH_TOKEN environment variable is in force, and it is not working.");
  });
});

describe("parseGithubRepoList", () => {
  it("keeps gh's most-recently-updated order and drops nameless rows", () => {
    const repos = parseGithubRepoList(JSON.stringify([
      { isPrivate: false, nameWithOwner: "phuryn/afkpilot", updatedAt: "2026-09-03T21:55:15Z" },
      { isPrivate: true, nameWithOwner: "phuryn/secret", updatedAt: "2026-09-01T00:00:00Z" },
      { isPrivate: false, nameWithOwner: "", updatedAt: "2026-09-01T00:00:00Z" },
    ]));
    expect(repos).toEqual([
      { nameWithOwner: "phuryn/afkpilot", isPrivate: false, updatedAt: "2026-09-03T21:55:15Z" },
      { nameWithOwner: "phuryn/secret", isPrivate: true, updatedAt: "2026-09-01T00:00:00Z" },
    ]);
  });
});

describe("redactGithubSecret", () => {
  it("strips a known secret and any token-shaped string", () => {
    const secret = "github_pat_abcdefghijklmnopqrstuvwxyz0123456789";
    expect(redactGithubSecret(`failed: ${secret} ghp_ABCDEFG`, secret)).toBe("failed: [token] [token]");
  });
});

describe("readGithubAuthState", () => {
  it("asks gh api user --jq .login, not auth status --json", async () => {
    let seen: unknown[] | undefined;
    const io = execIo((args, cb) => {
      seen = args;
      cb(null, "phuryn\n", "");
    });
    const state = await readGithubAuthState(io, {});
    expect(seen?.[0]).toBe("gh");
    expect(seen?.[1]).toEqual([...GITHUB_API_USER_ARGS]);
    expect(state).toEqual({
      connected: true,
      login: "phuryn",
      envTokenInForce: false,
      error: false,
      cliPresent: true,
    });
  });

  it("still reports a working login when the fake gh is 2.79 (no auth status --json)", async () => {
    const io = execIo((args, cb) => {
      const argv = args[1] as string[];
      if (argv[0] === "auth" && argv[1] === "status") {
        cb(Object.assign(new Error("unknown flag: --json"), { code: 1 }), "", "unknown flag: --json");
        return;
      }
      expect(argv).toEqual([...GITHUB_API_USER_ARGS]);
      cb(null, "phuryn\n", "");
    });
    const state = await readGithubAuthState(io, {});
    expect(state.connected).toBe(true);
    expect(state.login).toBe("phuryn");
  });

  it("does not treat a failed api user's JSON stdout as the login", async () => {
    const io = execIo((_args, cb) => {
      cb(Object.assign(new Error("exit 1"), { code: 1 }), '{"message":"Bad credentials"}\n', "");
    });
    const state = await readGithubAuthState(io, {});
    expect(state).toEqual(DISCONNECTED_GITHUB);
    expect(state.login).toBe("");
  });

  it("names a broken env token instead of looking merely disconnected", async () => {
    const io = execIo((_args, cb) => {
      cb(Object.assign(new Error("exit 1"), { code: 1 }), '{"message":"Bad credentials"}\n', "");
    });
    const state = await readGithubAuthState(io, { GH_TOKEN: "github_pat_SHOULD_NOT_LEAK" });
    expect(state.connected).toBe(false);
    expect(state.error).toBe(true);
    expect(state.envTokenInForce).toBe(true);
    expect(state.login).toBe("");
    expect(state.message).toBe(githubEnvTokenBrokenMessage("GH_TOKEN"));
    expect(JSON.stringify(state)).not.toContain("github_pat_");
    expect(JSON.stringify(state)).not.toContain("SHOULD_NOT_LEAK");
  });

  it("reports a missing CLI rather than throwing", async () => {
    const io = execIo((_args, cb) => cb(Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }), "", ""));
    const state = await readGithubAuthState(io, {});
    expect(state.cliPresent).toBe(false);
    expect(state.connected).toBe(false);
  });
});

describe("listGithubRepositories", () => {
  it("caps at gh's --limit and marks truncation at that cap", async () => {
    const rows = Array.from({ length: GITHUB_REPO_LIST_LIMIT }, (_, i) => ({
      isPrivate: false,
      nameWithOwner: `phuryn/r${i}`,
      updatedAt: "2026-09-03T00:00:00Z",
    }));
    const io = execIo((args, cb) => {
      expect(args[1]).toEqual([...GITHUB_REPO_LIST_ARGS]);
      cb(null, JSON.stringify(rows), "");
    });
    const result = await listGithubRepositories(io, {});
    expect(result.repos).toHaveLength(GITHUB_REPO_LIST_LIMIT);
    expect(result.truncated).toBe(true);
  });
});

describe("logoutGithub", () => {
  it("names the account so gh does not prompt", async () => {
    expect(githubLogoutArgs("phuryn")).toEqual([
      "auth", "logout", "--hostname", "github.com", "--user", "phuryn",
    ]);
    const io = execIo((args, cb) => {
      expect(args[1]).toEqual(githubLogoutArgs("phuryn"));
      cb(null, "", "");
    });
    expect(await logoutGithub("phuryn", io, {})).toEqual({ ok: true });
  });
});

describe("loginGithubWithToken", () => {
  it("writes the token to stdin, never argv, then runs setup-git", async () => {
    const children: FakeChild[] = [];
    const calls: unknown[][] = [];
    const io: GithubAuthIo = {
      execFile: vi.fn() as unknown as GithubAuthIo["execFile"],
      spawn: ((...args: unknown[]) => {
        calls.push(args);
        const child = new FakeChild();
        children.push(child);
        return child;
      }) as unknown as GithubAuthIo["spawn"],
    };
    const token = "github_pat_testtokenvalue0000000000000000000000";
    const pending = loginGithubWithToken(token, io, {});
    expect(calls[0][1]).toEqual([...GITHUB_AUTH_LOGIN_WITH_TOKEN_ARGS]);
    expect(JSON.stringify(calls[0][1])).not.toContain(token);
    expect(children[0].stdin.writes.join("")).toBe(token);
    children[0].emit("close", 0);
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1][1]).toEqual([...GITHUB_AUTH_SETUP_GIT_ARGS]);
    children[1].emit("close", 0);
    expect(await pending).toEqual({ ok: true });
  });

  it("refuses a pasted token when GH_TOKEN is already in force, without spawning gh", async () => {
    const io: GithubAuthIo = {
      execFile: vi.fn() as unknown as GithubAuthIo["execFile"],
      spawn: vi.fn() as unknown as GithubAuthIo["spawn"],
    };
    const token = "github_pat_testtokenvalue0000000000000000000000";
    const result = await loginGithubWithToken(token, io, { GH_TOKEN: "already-set-secret" });
    expect(result).toEqual({ ok: false, error: githubEnvTokenBlocksPasteMessage("GH_TOKEN") });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain("already-set-secret");
    expect(io.spawn).not.toHaveBeenCalled();
  });

  it("redacts a token that gh echoed", async () => {
    const children: FakeChild[] = [];
    const io: GithubAuthIo = {
      execFile: vi.fn() as unknown as GithubAuthIo["execFile"],
      spawn: (() => {
        const child = new FakeChild();
        children.push(child);
        return child;
      }) as unknown as GithubAuthIo["spawn"],
    };
    const token = "github_pat_ECHO_ME_PLEASE_00000000000000000000";
    const pending = loginGithubWithToken(token, io, {});
    children[0].stderr.emit("data", `GitHub did not accept that token. ${token}`);
    children[0].emit("close", 1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it("refuses an empty or oversized paste before spawning", async () => {
    const io: GithubAuthIo = {
      execFile: vi.fn() as unknown as GithubAuthIo["execFile"],
      spawn: vi.fn() as unknown as GithubAuthIo["spawn"],
    };
    expect(await loginGithubWithToken("  ", io, {})).toEqual({ ok: false, error: "Paste a GitHub token." });
    expect(await loginGithubWithToken("x".repeat(MAX_GITHUB_TOKEN_CHARS + 1), io, {})).toEqual({
      ok: false,
      error: "That token is too long.",
    });
    expect(io.spawn).not.toHaveBeenCalled();
  });
});
