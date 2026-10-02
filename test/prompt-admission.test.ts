import { afterEach, describe, expect, it, vi } from "vitest";
import { PromptAdmission } from "../src/prompt-admission";
import { AcpClient } from "../src/acp";
import { GeminiBackend } from "../src/gemini-backend";

afterEach(() => { vi.useRealTimers(); });
const policy = { maxActiveTurns: 1, minStartSpacingMs: 0 };
const signal = () => new AbortController().signal;

describe("prompt admission", () => {
  it("respects FIFO capacity, skips cancelled waiters and releases once", async () => {
    const queue = new PromptAdmission();
    const release1 = await queue.acquire(policy, signal());
    const aborted = new AbortController();
    const waiting2 = queue.acquire(policy, aborted.signal);
    const denied = expect(waiting2).rejects.toThrow("cancelled");
    let acquired3 = false;
    const waiting3 = queue.acquire(policy, signal()).then(release => { acquired3 = true; return release; });
    aborted.abort(); await denied;
    expect(acquired3).toBe(false);
    release1(); release1();
    const release3 = await waiting3;
    expect(acquired3).toBe(true); release3();
    const release4 = await queue.acquire(policy, signal()); release4();
  });

  it("enforces spacing and removes timers when a delayed start is cancelled", async () => {
    vi.useFakeTimers();
    const queue = new PromptAdmission();
    const release = await queue.acquire({ maxActiveTurns: 2, minStartSpacingMs: 2000 }, signal());
    const aborted = new AbortController();
    const waiting = queue.acquire({ maxActiveTurns: 2, minStartSpacingMs: 2000 }, aborted.signal);
    const assertion = expect(waiting).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(1999);
    aborted.abort(); await assertion;
    expect(vi.getTimerCount()).toBe(0);
    const next = queue.acquire({ maxActiveTurns: 2, minStartSpacingMs: 2000 }, signal());
    await vi.advanceTimersByTimeAsync(1);
    const release2 = await next; release(); release2();
  });

  it.each([-1, 1.5, NaN])("rejects invalid enabled configuration (%s)", async maxActiveTurns => {
    await expect(new PromptAdmission().acquire({ maxActiveTurns, minStartSpacingMs: 0 }, signal())).rejects.toThrow("configuration");
  });

  it("disabled admission permits concurrent starts", async () => {
    const queue = new PromptAdmission();
    const releases = await Promise.all([1, 2, 3].map(() => queue.acquire({ maxActiveTurns: 0, minStartSpacingMs: 2000 }, signal())));
    for (const release of releases) release();
  });
});

function clients() {
  const coordinator = new PromptAdmission();
  const make = () => {
    const backend = new GeminiBackend();
    vi.spyOn(backend, "promptAdmission").mockReturnValue({ coordinator, policy });
    const client = new AcpClient({ cliPath: "unused", cwd: process.cwd(), log: () => {}, backend });
    client.sessionId = "test-session";
    vi.spyOn(client as any, "checkPromptContext").mockResolvedValue(undefined);
    let finish!: (result: unknown) => void;
    const request = vi.spyOn(client as any, "request").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    return { client, request, finish: () => finish({ stopReason: "end_turn" }) };
  };
  return [make(), make()] as const;
}
async function tick() { for (let i = 0; i < 8; i++) await Promise.resolve(); }

describe("admission at ACP prompt dispatch", () => {
  it("coordinates separate clients, releasing the slot after RPC failure", async () => {
    const [first, second] = clients();
    first.request.mockRejectedValueOnce(new Error("backend failed"));
    const failed = expect(first.client.prompt("first")).rejects.toThrow("backend failed");
    const next = second.client.prompt("second");
    await failed; await tick();
    expect(second.request).toHaveBeenCalledOnce();
    second.finish(); await next;
  });

  it.each(["cancel", "dispose"])("%s resolves a waiting turn without sending its prompt", async action => {
    const [first, second] = clients();
    const running = first.client.prompt("first"); await tick();
    const waiting = second.client.prompt("second"); await tick();
    expect(second.request).not.toHaveBeenCalled();
    if (action === "cancel") await second.client.cancel(); else await second.client.dispose();
    await expect(waiting).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(second.request).not.toHaveBeenCalled();
    first.finish(); await running;
  });

  it("ordinary backends dispatch immediately without Antigravity admission", async () => {
    const client = new AcpClient({ cliPath: "unused", cwd: process.cwd(), log: () => {} });
    client.sessionId = "grok-session";
    vi.spyOn(client as any, "checkPromptContext").mockResolvedValue(undefined);
    const request = vi.spyOn(client as any, "request").mockResolvedValue({ stopReason: "end_turn" });
    await client.prompt("hello");
    expect(request).toHaveBeenCalledOnce();
  });

  it("cancels preparation before admission without dispatching a later prompt", async () => {
    const [first] = clients();
    vi.spyOn(first.client as any, "checkPromptContext").mockReturnValue(new Promise(() => {}));
    const prompt = first.client.prompt("preparing");
    await first.client.cancel();
    await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(first.request).not.toHaveBeenCalled();
  });
});
