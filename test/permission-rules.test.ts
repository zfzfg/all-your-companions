/**
 * AP-07 permission-rule engine (pure).
 *
 * Pins the security-sensitive order: the floor cannot be overridden, Deny
 * always wins, then last-match-wins, and an empty list is today's `ask`.
 */
import { describe, expect, it } from "vitest";
import {
  PERMISSION_RULES_ORDER_COPY,
  SOCKET_RULE_VIEWS,
  activeRulesFrom,
  canonicalPath,
  createRule,
  decidePermission,
  evaluateRules,
  evaluateSocket,
  extractPermissionFacts,
  formatRuleSummary,
  globalRulesToMap,
  hashRulesText,
  isConcreteAllowMatch,
  isCredentialFilePath,
  isPathUnder,
  isSystemPath,
  matchPathGlob,
  parseAdoptionMap,
  parseGlobalRulesMap,
  parseRule,
  parseWorkspaceRulesFile,
  pendingWorkspaceAdoption,
  permissionRulesNotice,
  pickAllowOnceOption,
  relativizeToRoot,
  sanitizeWebviewAllowMatch,
  serializeWorkspaceRulesFile,
  suggestRules,
  toRuleView,
  workspaceRulesPath,
  writeWorkspaceRulesFile,
  type PermissionRule,
  type PermissionRulesFs,
  type PermissionRequestFacts,
} from "../src/permission-rules";

function rule(partial: Partial<PermissionRule> & Pick<PermissionRule, "id" | "action" | "match">): PermissionRule {
  return {
    scope: "workspace",
    createdAt: 1,
    ...partial,
  };
}

function facts(partial: Partial<PermissionRequestFacts>): PermissionRequestFacts {
  return {
    tool: "",
    kind: "other",
    paths: [],
    ...partial,
  };
}

describe("evaluation order copy", () => {
  it("is the single source of truth the UI must paint", () => {
    expect(PERMISSION_RULES_ORDER_COPY).toContain("safety floor");
    expect(PERMISSION_RULES_ORDER_COPY).toContain("cannot be overridden");
    expect(PERMISSION_RULES_ORDER_COPY).toContain("Deny wins");
    expect(PERMISSION_RULES_ORDER_COPY).toContain("last-match-wins");
  });

  it("exposes the floor as its own non-deletable list", () => {
    expect(SOCKET_RULE_VIEWS.every((r) => r.source === "socket" && r.deletable === false)).toBe(true);
    expect(SOCKET_RULE_VIEWS.map((r) => r.id)).toEqual([
      "socket-delete-system",
      "socket-credential-write",
    ]);
  });
});

describe("empty list is today's behaviour", () => {
  it("evaluateRules([]) → ask, with no ruleId", () => {
    expect(evaluateRules([], facts({ kind: "execute", command: "npm test" }))).toEqual({
      action: "ask",
    });
  });

  it("decidePermission with no rules and a routine request → ask", () => {
    expect(decidePermission([], facts({ kind: "edit", paths: ["src/a.ts"] }))).toEqual({
      action: "ask",
    });
  });
});

describe("deny always wins, then last-match-wins", () => {
  const allowSrc = rule({
    id: "allow-src",
    action: "allow",
    match: { kind: "edit", pathGlob: "src/**" },
  });
  const denyEnv = rule({
    id: "deny-env",
    action: "deny",
    match: { kind: "edit", pathGlob: "**/.env*" },
  });
  const allowAllEdits = rule({
    id: "allow-edits",
    action: "allow",
    match: { kind: "edit", pathGlob: "**/*.ts" },
  });

  it("a later allow cannot override an earlier deny", () => {
    const verdict = evaluateRules(
      [denyEnv, allowAllEdits],
      facts({ kind: "edit", paths: [".env"] }),
    );
    expect(verdict).toEqual({ action: "deny", ruleId: "deny-env" });
  });

  it("among remaining (non-deny) matches, the last one wins", () => {
    const first = rule({
      id: "first",
      action: "ask",
      match: { kind: "execute", commandPrefix: "npm" },
    });
    const last = rule({
      id: "last",
      action: "allow",
      match: { kind: "execute", commandPrefix: "npm test" },
    });
    expect(evaluateRules(
      [first, last],
      facts({ kind: "execute", command: "npm test --watch" }),
    )).toEqual({ action: "allow", ruleId: "last" });
  });

  it("an unmatched deny does not block a later allow", () => {
    expect(evaluateRules(
      [denyEnv, allowSrc],
      facts({ kind: "edit", paths: ["src/a.ts"] }),
    )).toEqual({ action: "allow", ruleId: "allow-src" });
  });
});

describe("glob boundaries", () => {
  it("src/** matches src, src/foo, src/foo/bar — not srcfoo", () => {
    expect(matchPathGlob("src/**", "src/foo")).toBe(true);
    expect(matchPathGlob("src/**", "src/foo/bar.ts")).toBe(true);
    expect(matchPathGlob("src/**", "src")).toBe(true);
    expect(matchPathGlob("src/**", "srcfoo")).toBe(false);
    expect(matchPathGlob("src/**", "srcfoo/bar")).toBe(false);
  });

  it("src/* matches one segment, not nested and not srcfoo", () => {
    expect(matchPathGlob("src/*", "src/a.ts")).toBe(true);
    expect(matchPathGlob("src/*", "src/foo/a.ts")).toBe(false);
    expect(matchPathGlob("src/*", "srcfoo")).toBe(false);
  });

  it("Windows backslashes and case fold", () => {
    expect(matchPathGlob("src/**", "src\\foo.ts", true)).toBe(true);
    expect(matchPathGlob("SRC/**", "src\\foo.ts", true)).toBe(true);
    expect(matchPathGlob("src/**", "srcfoo", true)).toBe(false);
  });

  it("isPathUnder is segment-boundary, not string-prefix", () => {
    expect(isPathUnder("/repo/src", "/repo/src/a.ts")).toBe(true);
    expect(isPathUnder("/repo/src", "/repo/srcfoo")).toBe(false);
    expect(isPathUnder("C:\\repo\\src", "C:\\repo\\src\\a.ts")).toBe(true);
    expect(isPathUnder("C:\\repo\\src", "C:\\repo\\srcfoo")).toBe(false);
  });

  it("allow pathGlob requires EVERY path; deny fires on ANY path", () => {
    const allowSrc = rule({
      id: "a",
      action: "allow",
      match: { kind: "edit", pathGlob: "src/**" },
    });
    const denyEnv = rule({
      id: "d",
      action: "deny",
      match: { kind: "edit", pathGlob: "**/.env*" },
    });
    expect(evaluateRules([allowSrc], facts({
      kind: "edit",
      paths: ["src/a.ts", "src/b.ts"],
    })).action).toBe("allow");
    expect(evaluateRules([allowSrc], facts({
      kind: "edit",
      paths: ["src/a.ts", "README.md"],
    })).action).toBe("ask");
    expect(evaluateRules([denyEnv], facts({
      kind: "edit",
      paths: ["src/a.ts", ".env"],
    })).action).toBe("deny");
  });
});

describe("command prefix", () => {
  const npmTest = rule({
    id: "npm-test",
    action: "allow",
    match: { kind: "execute", commandPrefix: "npm test" },
  });

  it("matches the command plus arguments, not a glued suffix", () => {
    expect(evaluateRules([npmTest], facts({
      kind: "execute",
      command: "npm test --watch",
    })).action).toBe("allow");
    expect(evaluateRules([npmTest], facts({
      kind: "execute",
      command: "npm test",
    })).action).toBe("allow");
    expect(evaluateRules([npmTest], facts({
      kind: "execute",
      command: "npm testfoo",
    })).action).toBe("ask");
    expect(evaluateRules([npmTest], facts({
      kind: "execute",
      command: "npx test",
    })).action).toBe("ask");
  });

  it("collapses extra whitespace", () => {
    expect(evaluateRules([npmTest], facts({
      kind: "execute",
      command: "  npm   test   --coverage  ",
    })).action).toBe("allow");
  });
});

describe("safety floor is unbypassable", () => {
  const allowEverythingExecute = rule({
    id: "yolo-exec",
    action: "allow",
    match: { kind: "execute", commandPrefix: "rm" },
  });
  const allowEnv = rule({
    id: "allow-env",
    action: "allow",
    match: { kind: "edit", pathGlob: "**/.env*" },
  });

  it("denies rm -rf / even when a user allow-rule matches", () => {
    const decision = decidePermission(
      [allowEverythingExecute],
      facts({ kind: "execute", command: "rm -rf /" }),
    );
    expect(decision.action).toBe("deny");
    expect(decision).toMatchObject({ source: "socket" });
  });

  it("denies Remove-Item on C:\\Windows", () => {
    const decision = decidePermission([], facts({
      kind: "execute",
      command: "Remove-Item -Recurse -Force C:\\Windows\\System32",
    }));
    expect(decision).toMatchObject({ action: "deny", source: "socket" });
  });

  it("denies a write to .env even when a user allow-rule matches", () => {
    const decision = decidePermission(
      [allowEnv],
      facts({ kind: "edit", paths: ["/.env"] }),
    );
    expect(decision.action).toBe("deny");
    expect(decision).toMatchObject({ source: "socket" });
  });

  it("does not fire on a routine npm test", () => {
    expect(evaluateSocket(facts({ kind: "execute", command: "npm test" }))).toBeUndefined();
    expect(decidePermission([], facts({ kind: "execute", command: "npm test" })).action).toBe("ask");
  });

  it("does not treat npm rm as a system delete", () => {
    expect(evaluateSocket(facts({ kind: "execute", command: "npm rm lodash" }))).toBeUndefined();
  });

  it("credential-file names match the sensitiveFilesWarn set", () => {
    expect(isCredentialFilePath(".env")).toBe(true);
    expect(isCredentialFilePath(".env.local")).toBe(true);
    expect(isCredentialFilePath("server.pem")).toBe(true);
    expect(isCredentialFilePath("id_rsa")).toBe(true);
    expect(isCredentialFilePath("id_ed25519")).toBe(true);
    expect(isCredentialFilePath("tls.key")).toBe(true);
    expect(isCredentialFilePath("src/a.ts")).toBe(false);
  });

  it("system paths include OS roots, not a workspace sibling", () => {
    expect(isSystemPath("/")).toBe(true);
    expect(isSystemPath("/usr/bin")).toBe(true);
    expect(isSystemPath("C:\\Windows\\System32")).toBe(true);
    expect(isSystemPath("/home/me/proj")).toBe(false);
    expect(isSystemPath("/workspace")).toBe(false);
  });
});

describe("extractPermissionFacts + suggestions", () => {
  it("reads command and file_path from rawInput", () => {
    expect(extractPermissionFacts({
      kind: "execute",
      title: "Run tests",
      rawInput: { command: "npm test --watch" },
    })).toEqual({
      tool: "",
      kind: "execute",
      command: "npm test --watch",
      paths: [],
    });
    expect(extractPermissionFacts({
      kind: "edit",
      rawInput: { file_path: "/repo/src/a.ts" },
    }).paths).toEqual(["/repo/src/a.ts"]);
  });

  it("maps write/delete/move onto kind edit", () => {
    expect(extractPermissionFacts({ kind: "write" }).kind).toBe("edit");
    expect(extractPermissionFacts({ kind: "delete" }).kind).toBe("edit");
    expect(extractPermissionFacts({ kind: "move" }).kind).toBe("edit");
    expect(extractPermissionFacts({ kind: "read" }).kind).toBe("read");
  });

  it("suggests npm test and npm * from a concrete command, never a bare execute", () => {
    const s = suggestRules(facts({ kind: "execute", command: "npm test --watch" }));
    expect(s.map((x) => x.label)).toEqual(["npm test", "npm *"]);
    expect(s.every((x) => isConcreteAllowMatch(x.match))).toBe(true);
    expect(s.some((x) => !x.match.commandPrefix && !x.match.pathGlob)).toBe(false);
  });

  it("suggests src/** for a read under src/, not srcfoo", () => {
    const s = suggestRules(
      facts({ kind: "read", paths: ["/repo/src/foo.ts"] }),
      "/repo",
    );
    expect(s.some((x) => x.match.pathGlob === "src/**")).toBe(true);
    expect(s.some((x) => x.match.pathGlob === "src/foo.ts")).toBe(true);
    expect(s.some((x) => x.match.pathGlob === "srcfoo/**")).toBe(false);
  });
});

describe("webview allow-match sanitizer", () => {
  it("rejects empty, unbounded, and kind-only allow matches", () => {
    expect(sanitizeWebviewAllowMatch({})).toBeUndefined();
    expect(sanitizeWebviewAllowMatch({ kind: "execute" })).toBeUndefined();
    expect(sanitizeWebviewAllowMatch({ pathGlob: "**" })).toBeUndefined();
    expect(sanitizeWebviewAllowMatch({ commandPrefix: "*" })).toBeUndefined();
  });

  it("accepts a concrete prefix or glob", () => {
    expect(sanitizeWebviewAllowMatch({ kind: "execute", commandPrefix: "npm test" })).toEqual({
      kind: "execute",
      commandPrefix: "npm test",
    });
    expect(sanitizeWebviewAllowMatch({ kind: "read", pathGlob: "src/**" })).toEqual({
      kind: "read",
      pathGlob: "src/**",
    });
  });
});

describe("parse / persist shapes", () => {
  it("skips allow-everything rules in a workspace file (fail closed)", () => {
    const parsed = parseWorkspaceRulesFile({
      version: 1,
      rules: [
        { id: "bad", action: "allow", scope: "workspace", createdAt: 1, match: {} },
        { id: "ok", action: "deny", scope: "workspace", createdAt: 2, match: { kind: "execute" } },
      ],
    });
    expect(parsed?.map((r) => r.id)).toEqual(["ok"]);
  });

  it("refuses an unknown version instead of applying it", () => {
    expect(parseWorkspaceRulesFile({ version: 2, rules: [] })).toBeUndefined();
    expect(parseWorkspaceRulesFile({ rules: [] })).toBeUndefined();
  });

  it("round-trips a workspace file", () => {
    const rules = [rule({
      id: "r1",
      action: "allow",
      match: { kind: "execute", commandPrefix: "npm test" },
      note: "from card",
    })];
    const parsed = parseWorkspaceRulesFile(JSON.parse(serializeWorkspaceRulesFile(rules)));
    expect(parsed).toEqual(rules);
  });

  it("global map is a record of records (PersistedState validValue)", () => {
    const rules = [rule({
      id: "g1",
      action: "deny",
      scope: "global",
      match: { kind: "execute", commandPrefix: "rm" },
    })];
    const map = globalRulesToMap(rules);
    expect(Array.isArray(map)).toBe(false);
    expect(parseGlobalRulesMap(map)).toEqual(rules);
  });

  it("adoption map ignores malformed rows", () => {
    expect(parseAdoptionMap({
      "/proj": { hash: "abc", status: "adopted", at: 1 },
      "/bad": { hash: "x" },
    })).toEqual({ "/proj": { hash: "abc", status: "adopted", at: 1 } });
  });

  it("hash changes when the file bytes change", () => {
    expect(hashRulesText("a")).not.toBe(hashRulesText("b"));
    expect(hashRulesText("a")).toBe(hashRulesText("a"));
  });

  it("workspaceRulesPath is .grok/permissions.json under cwd", () => {
    expect(workspaceRulesPath("/repo")).toBe("/repo/.grok/permissions.json");
    expect(workspaceRulesPath("C:\\repo")).toBe("C:\\repo\\.grok\\permissions.json");
  });

  it("writeWorkspaceRulesFile uses one write of the full payload", () => {
    const writes: Array<{ p: string; data: string }> = [];
    const fs: PermissionRulesFs = {
      existsSync: () => false,
      readFileSync: () => "",
      mkdirSync: () => {},
      writeFileSync: (p, data) => { writes.push({ p, data }); },
    };
    const rules = [rule({
      id: "r1",
      action: "allow",
      match: { kind: "read", pathGlob: "src/**" },
    })];
    writeWorkspaceRulesFile("/repo", rules, fs);
    expect(writes).toHaveLength(1);
    expect(writes[0].p).toBe("/repo/.grok/permissions.json");
    expect(JSON.parse(writes[0].data).rules).toHaveLength(1);
  });
});

describe("adoption gate", () => {
  const file = {
    hash: "aaa",
    rules: [rule({ id: "w1", action: "allow", match: { kind: "read", pathGlob: "src/**" } })],
  };

  it("does not apply a checked-in file until the hash is adopted", () => {
    const global: PermissionRule[] = [];
    expect(activeRulesFrom(global, file, undefined)).toEqual([]);
    expect(pendingWorkspaceAdoption(file, undefined)).toBe(true);
    expect(activeRulesFrom(global, file, { hash: "aaa", status: "declined", at: 1 })).toEqual([]);
    expect(activeRulesFrom(global, file, { hash: "bbb", status: "adopted", at: 1 })).toEqual([]);
    expect(activeRulesFrom(global, file, { hash: "aaa", status: "adopted", at: 1 })).toEqual(file.rules);
    expect(pendingWorkspaceAdoption(file, { hash: "aaa", status: "adopted", at: 1 })).toBe(false);
  });

  it("re-asks when the file bytes change after adoption", () => {
    expect(pendingWorkspaceAdoption(
      { ...file, hash: "ccc" },
      { hash: "aaa", status: "adopted", at: 1 },
    )).toBe(true);
  });
});

describe("helpers the host applies", () => {
  it("pickAllowOnceOption prefers once so the floor still sees later requests", () => {
    expect(pickAllowOnceOption([
      { optionId: "always", kind: "allow_always" },
      { optionId: "once", kind: "allow_once" },
    ])).toBe("once");
  });

  it("transcript lines name the source", () => {
    expect(permissionRulesNotice({
      action: "allow",
      source: "rule",
      ruleId: "r1",
      reason: "allow execute npm test (workspace)",
    })).toContain("Allowed by rule");
    expect(permissionRulesNotice({
      action: "deny",
      source: "socket",
      reason: "delete command on a system path",
    })).toMatch(/safety floor/);
  });

  it("toRuleView marks user rules deletable", () => {
    const view = toRuleView(rule({
      id: "r1",
      action: "allow",
      match: { kind: "read", pathGlob: "src/**" },
    }));
    expect(view.deletable).toBe(true);
    expect(view.source).toBe("workspace");
    expect(formatRuleSummary(rule({
      id: "r1",
      action: "allow",
      match: { kind: "read", pathGlob: "src/**" },
    }))).toContain("src/**");
  });

  it("createRule + parseRule round-trip", () => {
    const created = createRule({
      id: "x",
      createdAt: 42,
      action: "allow",
      scope: "global",
      match: { kind: "execute", commandPrefix: "npm test" },
      note: "from card",
    });
    expect(parseRule(created)).toEqual(created);
  });

  it("canonicalPath lower-cases Windows and keeps POSIX case", () => {
    expect(canonicalPath("C:\\Windows\\System32").norm).toBe("c:/windows/system32");
    expect(canonicalPath("/Usr/Bin").norm).toBe("/Usr/Bin");
  });

  it("relativizeToRoot does not treat srcfoo as inside src", () => {
    expect(relativizeToRoot("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(relativizeToRoot("/repo/srcfoo", "/repo/src")).toBeUndefined();
  });
});
