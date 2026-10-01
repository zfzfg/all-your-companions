import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextCatalogReader, modelsMatch, type ContextCatalogSnapshot } from "../src/context-catalog";

const roots: string[] = [];
const readers: ContextCatalogReader[] = [];
afterEach(() => {
  for (const reader of readers.splice(0)) reader.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "companions-context-catalog-test-"));
  roots.push(root);
  const updates: ContextCatalogSnapshot[] = [];
  const log = vi.fn();
  const reader = new ContextCatalogReader("grok", { GROK_HOME: root }, snapshot => updates.push(snapshot), log);
  readers.push(reader);
  const file = path.join(root, "models_cache.json");
  const write = (id: string, size: number) => fs.writeFileSync(file, JSON.stringify({ fetched_at: new Date().toISOString(), models: {
    [id]: { api_key: "must-not-escape", info: { context_window: size } },
  } }));
  return { reader, updates, file, write, log };
}

describe("catalog file lifecycle", () => {
  it("matches exact model ids without guessing aliases or newer generations", () => {
    expect(modelsMatch("model-1", "model-1")).toBe(true);
    for (const id of ["model-1-new", "model.1", "provider/model-1", "MODEL-1"]) {
      expect(modelsMatch("model-1", id)).toBe(false);
    }
  });
  it("refreshes native metadata and retains stale data after async read/parse failure", async () => {
    const { reader, updates, file, write, log } = setup();
    write("grok-4.7", 256000);
    await reader.refresh();
    expect(updates.at(-1)?.models[0].limits.contextWindow).toBe(256000);
    fs.writeFileSync(file, "{broken");
    await reader.refresh();
    expect(updates.at(-1)?.stale).toBe(true);
    fs.unlinkSync(file);
    await reader.refresh();
    expect(updates.at(-1)?.models[0].modelId).toBe("grok-4.7");
    expect(JSON.stringify(updates)).not.toContain("must-not-escape");
    expect(log).not.toHaveBeenCalled();
  });
  it("debounces file updates, discovers new models, and stops publishing after disposal", async () => {
    const { reader, updates, write } = setup();
    write("grok-4.7", 256000);
    reader.start();
    await vi.waitFor(() => expect(updates.length).toBeGreaterThan(0));
    write("grok-new", 128000);
    await vi.waitFor(() => expect(updates.at(-1)?.models[0].modelId).toBe("grok-new"));
    reader.dispose();
    const before = updates.length;
    write("after-dispose", 500000);
    await reader.refresh();
    expect(updates).toHaveLength(before);
  });
  it("handles asynchronous watcher errors without crashing or leaking contents", async () => {
    const { reader, write, log } = setup();
    write("grok-4.7", 256000);
    reader.start();
    (reader as any).watcher.emit("error", new Error("must-not-escape"));
    expect(log).toHaveBeenCalledWith("[context] model catalog watcher unavailable; refresh on next send");
    expect((reader as any).watcher).toBeUndefined();
    await reader.refresh();
  });
});
