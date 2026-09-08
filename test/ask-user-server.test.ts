// AP-05 — the pure half of the host `ask_user` MCP server.
//
// Everything here runs without a socket, a process or a clock. The IPC that
// needs all three lives in `ask-user-ipc.test.ts`.
//
// The two things this file is really guarding:
//
//   1. **Tolerance.** A strict schema is why the same feature failed in Kilo and
//      OpenCode (market report §3.3): the model quietly stops using a tool it
//      keeps failing to call. Every repair below is a case a model actually
//      sends. Only a missing `question` is an error, and it comes back as a
//      tool RESULT so the model can fix it inside the same turn.
//   2. **The two copies agree.** `resources/mcp/ask-user-server.cjs` cannot
//      import the TypeScript module — it ships as plain CJS with no build step —
//      so it restates the constants and the normalizer. A drift between them is
//      a bug that only shows up against a real CLI, which no test in this suite
//      is allowed to start. The last describe block pins them.
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ASK_USER_ADDRESS_ENV,
  ASK_USER_IPC_VERSION,
  ASK_USER_SERVER_NAME,
  ASK_USER_TOKEN_ENV,
  ASK_USER_TOOL,
  askTimeoutMs,
  askUserErrorResult,
  checkHello,
  deriveHeader,
  encodeFrame,
  formatAskUserResult,
  normalizeAskUserArguments,
  parseClientFrame,
} from "../src/ask-user-protocol";
import { askUserPipeAddress } from "../src/ask-user-server";

function ok(args: unknown) {
  const result = normalizeAskUserArguments(args);
  if (!result.ok) throw new Error(`expected a normalized result, got: ${result.error}`);
  return result.questions;
}

describe("ask_user schema tolerance (§8.2)", () => {
  it("keeps a fully-specified question exactly as sent", () => {
    const [q] = ok({
      questions: [{
        question: "Which database?",
        header: "Database",
        multiSelect: true,
        options: [{ label: "Postgres", description: "relational" }, { label: "SQLite" }],
      }],
    });
    expect(q).toEqual({
      question: "Which database?",
      header: "Database",
      multiSelect: true,
      options: [{ label: "Postgres", description: "relational" }, { label: "SQLite" }],
    });
  });

  it("derives a missing header from the question, on a word boundary", () => {
    const [q] = ok({ questions: [{ question: "Which database should we use?", options: [{ label: "A" }, { label: "B" }] }] });
    // Not "Which databa" — a chopped word reads as a rendering fault.
    expect(q.header).toBe("Which");
  });

  it("keeps a short question whole as its own header", () => {
    expect(deriveHeader("Deploy now?")).toBe("Deploy now");
  });

  it("hard-cuts only when the first word is already too long", () => {
    expect(deriveHeader("Internationalization strategy?")).toBe("Internationa");
  });

  it("trims an over-long header instead of refusing the question", () => {
    const [q] = ok({ questions: [{ question: "Pick", header: "Way too long a header" }] });
    expect(q.header).toBe("Way too long");
  });

  it("treats missing options as a free-text question", () => {
    const [q] = ok({ questions: [{ question: "What should I name it?" }] });
    expect(q.options).toEqual([]);
    expect(q.multiSelect).toBe(false);
  });

  it("accepts bare strings where option objects were specified", () => {
    const [q] = ok({ questions: [{ question: "Pick", options: ["A", "B"] }] });
    expect(q.options).toEqual([{ label: "A" }, { label: "B" }]);
  });

  it("accepts a single question without the wrapper array", () => {
    const [q] = ok({ question: "Ship it?", options: [{ label: "Yes" }, { label: "No" }] });
    expect(q.question).toBe("Ship it?");
  });

  it("drops a lone option rather than render a choice of one", () => {
    // The question survives as free text, which is still answerable. Refusing
    // it would not be.
    const [q] = ok({ questions: [{ question: "Pick", options: [{ label: "Only" }] }] });
    expect(q.options).toEqual([]);
  });

  it("drops duplicate option labels, which would collide in the answer map", () => {
    const [q] = ok({ questions: [{ question: "Pick", options: ["A", "a", "B"] }] });
    expect(q.options.map((o) => o.label)).toEqual(["A", "B"]);
  });

  it("trims past the caps instead of failing the call", () => {
    const questions = ok({
      questions: Array.from({ length: 9 }, (_, i) => ({
        question: `Q${i}`,
        options: Array.from({ length: 9 }, (_, j) => ({ label: `O${j}` })),
      })),
    });
    expect(questions).toHaveLength(4);
    expect(questions[0].options).toHaveLength(4);
  });

  it("skips an unusable entry but keeps the usable ones", () => {
    const questions = ok({ questions: [{ header: "no question here" }, { question: "Real?" }] });
    expect(questions.map((q) => q.question)).toEqual(["Real?"]);
  });

  it("reports a missing question as an error message, never a throw", () => {
    for (const bad of [undefined, null, 42, "text", {}, { questions: [] }, { questions: [{ header: "x" }] }]) {
      const result = normalizeAskUserArguments(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/questions|question/);
    }
  });

  it("turns that message into a tool result, not a protocol error", () => {
    const result = askUserErrorResult("Every entry in `questions` needs a non-empty `question` string.");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("`question`");
  });
});

describe("the tool descriptor the model reads", () => {
  it("advertises exactly one tool, named ask_user (decision §18.2)", () => {
    expect(ASK_USER_TOOL.name).toBe("ask_user");
  });

  it("says WHEN to use it, not only what it does", () => {
    // An always-available question tool described only by its function gets
    // called for things the user never wanted to be interrupted for.
    expect(ASK_USER_TOOL.description).toMatch(/ONLY when the answer changes what you do next/);
  });

  it("requires only `question` per entry", () => {
    const item = ASK_USER_TOOL.inputSchema.properties.questions.items;
    expect(item.required).toEqual(["question"]);
  });
});

describe("answer mapping", () => {
  it("renders question → label lines, not JSON", () => {
    // Prose survives a context summarization pass; a nested object does not.
    const result = formatAskUserResult({
      t: "answer",
      id: "1",
      outcome: "accepted",
      answers: { "Which database?": "Postgres", "Deploy now?": "No" },
    });
    expect(result.content[0].text).toBe("Which database?: Postgres\nDeploy now?: No");
    expect(result.isError).toBeUndefined();
  });

  it("joins a multi-select answer as the card sent it", () => {
    const result = formatAskUserResult({
      t: "answer", id: "1", outcome: "accepted", answers: { "Which?": "A, C" },
    });
    expect(result.content[0].text).toBe("Which?: A, C");
  });

  it("carries a free-text note through", () => {
    const result = formatAskUserResult({
      t: "answer",
      id: "1",
      outcome: "accepted",
      answers: { "Why?": "Other" },
      annotations: { "Why?": { notes: "because the index is cold" } },
    });
    expect(result.content[0].text).toContain("Why? — note: because the index is cold");
  });

  it("reports a dismissal as a result, never as an error", () => {
    // isError reads to the model as a broken tool; a dismissal is a legitimate
    // outcome it has to keep working after.
    const result = formatAskUserResult({ t: "answer", id: "1", outcome: "cancelled" });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toMatch(/dismissed/);
  });

  it("says so when a timeout, not a person, settled the card", () => {
    expect(formatAskUserResult({ t: "answer", id: "1", outcome: "cancelled", auto: true }).content[0].text)
      .toMatch(/timed out/);
    expect(formatAskUserResult({
      t: "answer", id: "1", outcome: "accepted", auto: true, answers: { Q: "A" },
    }).content[0].text).toMatch(/continued automatically/);
  });
});

describe("frames", () => {
  it("round-trips through encode and parse", () => {
    const line = encodeFrame({ t: "ask", id: "7", questions: ok({ questions: [{ question: "Q?" }] }) });
    expect(line.endsWith("\n")).toBe(true);
    expect(parseClientFrame(line)).toEqual({
      t: "ask", id: "7", questions: [{ question: "Q?", header: "Q", multiSelect: false, options: [] }],
    });
  });

  it("ignores a line it cannot use instead of tearing the connection down", () => {
    // Blank keep-alives, a frame kind from a newer script, and half a line left
    // by a crash all arrive on a healthy connection.
    for (const line of ["", "   ", "not json", "[1,2]", '"text"', '{"t":"future"}', '{"t":"ask"}', '{"t":"hello"}']) {
      expect(parseClientFrame(line)).toBeUndefined();
    }
  });

  it("re-normalizes an ask frame — the other side of the pipe is untrusted too", () => {
    const frame = parseClientFrame(JSON.stringify({
      t: "ask", id: "1", questions: [{ question: "Q?", options: ["A", "B"], header: "much too long a header" }],
    }));
    expect(frame).toEqual({
      t: "ask",
      id: "1",
      questions: [{ question: "Q?", header: "much too lon", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
    });
  });

  it("drops an ask frame carrying no answerable question", () => {
    expect(parseClientFrame(JSON.stringify({ t: "ask", id: "1", questions: [{}] }))).toBeUndefined();
  });
});

describe("handshake", () => {
  const known = (token: string) => token === "good";

  it("accepts a known token at the current version", () => {
    expect(checkHello({ t: "hello", v: ASK_USER_IPC_VERSION, token: "good" }, known)).toEqual({ ok: true, token: "good" });
  });

  it("refuses an unknown token", () => {
    // This is the whole access control on Windows, where a named pipe has no
    // permissions of its own and any local process can connect to it.
    const verdict = checkHello({ t: "hello", v: ASK_USER_IPC_VERSION, token: "bad" }, known);
    expect(verdict).toEqual({ ok: false, reason: "unknown token" });
  });

  it("refuses a version it does not speak", () => {
    expect(checkHello({ t: "hello", v: 99, token: "good" }, known).ok).toBe(false);
  });

  it("refuses anything that is not a hello", () => {
    expect(checkHello({ t: "cancel", id: "1" }, known).ok).toBe(false);
    expect(checkHello(undefined, known).ok).toBe(false);
  });
});

describe("spawn address and environment", () => {
  it("uses the kernel pipe namespace on Windows and a socket file on POSIX", () => {
    expect(askUserPipeAddress("abc", "win32")).toBe("\\\\.\\pipe\\companions-ask-abc");
    expect(askUserPipeAddress("abc", "linux", "/tmp")).toBe(path.join("/tmp", "companions-ask-abc.sock"));
  });

  it("names the address and token env vars, which is where they must travel", () => {
    // Never argv: the process list is readable by anything on the machine.
    expect(ASK_USER_ADDRESS_ENV).toBe("COMPANIONS_ASK_USER_ADDRESS");
    expect(ASK_USER_TOKEN_ENV).toBe("COMPANIONS_ASK_USER_TOKEN");
  });
});

describe("companions.askTimeout", () => {
  it("means wait indefinitely unless a duration was chosen", () => {
    // Including for a typo: a bad value must not quietly start dismissing
    // questions on the user's behalf.
    for (const value of [undefined, "", "off", "  off  ", "nonsense", "30s"]) {
      expect(askTimeoutMs(value)).toBeUndefined();
    }
  });

  it("maps the three offered durations", () => {
    expect(askTimeoutMs("60s")).toBe(60_000);
    expect(askTimeoutMs("5m")).toBe(300_000);
    expect(askTimeoutMs("10m")).toBe(600_000);
  });
});

describe("the shipped script restates the module correctly", () => {
  const script = fs.readFileSync(
    path.join(__dirname, "..", "resources", "mcp", "ask-user-server.cjs"),
    "utf8",
  );

  it("carries the same constants", () => {
    for (const [name, value] of [
      ["ASK_USER_SERVER_NAME", ASK_USER_SERVER_NAME],
      ["ASK_USER_ADDRESS_ENV", ASK_USER_ADDRESS_ENV],
      ["ASK_USER_TOKEN_ENV", ASK_USER_TOKEN_ENV],
    ] as const) {
      expect(script).toContain(`const ${name} = "${value}";`);
    }
    expect(script).toContain(`const ASK_USER_IPC_VERSION = ${ASK_USER_IPC_VERSION};`);
  });

  it("advertises the same tool description", () => {
    expect(script).toContain(ASK_USER_TOOL.description);
  });

  it("reads the address and token from the environment and nowhere else", () => {
    expect(script).toContain(`process.env[ASK_USER_ADDRESS_ENV]`);
    expect(script).toContain(`process.env[ASK_USER_TOKEN_ENV]`);
    // A regression here is invisible until someone reads a process list.
    expect(script).not.toMatch(/process\.argv\[\s*[23]\s*\]/);
  });

  it("adds no dependency of its own", () => {
    // Production deps are deliberately four packages; this ships as-is.
    const requires = [...script.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
    expect(requires.every((id) => id.startsWith("node:"))).toBe(true);
  });

  it("answers initialize and tools/list from constants, before any I/O", () => {
    // Codex kills an MCP server that is slow to start (startup_timeout_sec).
    const handle = script.slice(script.indexOf("function handle(message)"));
    const initialize = handle.slice(handle.indexOf('case "initialize"'), handle.indexOf('case "tools/list"'));
    expect(initialize).not.toMatch(/await|whenReady|\.then\(/);
  });
});
