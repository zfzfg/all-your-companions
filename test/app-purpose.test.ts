import { describe, expect, it } from "vitest";
import {
  APP_PURPOSE_KEY,
  DEFAULT_APP_PURPOSE,
  continueChatDestinations,
  continueChatNeedsPopup,
  effectiveExpandCommandOutputs,
  effectiveShowThinking,
  isCodingPurpose,
  parseAppPurpose,
  shouldOfferThinkingControls,
  shouldOfferToolDetailControls,
  shouldOfferWorktrees,
} from "../src/app-purpose";
import { DISK_KEYS, PersistedState, type MementoLike, type StateFs } from "../src/persisted-state";

describe("parseAppPurpose", () => {
  it("defaults absent/invalid to knowledge work", () => {
    expect(parseAppPurpose(undefined)).toBe("knowledge");
    expect(parseAppPurpose(null)).toBe("knowledge");
    expect(parseAppPurpose("")).toBe("knowledge");
    expect(parseAppPurpose("agent")).toBe("knowledge");
    expect(parseAppPurpose(1)).toBe("knowledge");
    expect(DEFAULT_APP_PURPOSE).toBe("knowledge");
  });

  it("accepts coding", () => {
    expect(parseAppPurpose("coding")).toBe("coding");
    expect(isCodingPurpose("coding")).toBe(true);
    expect(isCodingPurpose("knowledge")).toBe(false);
  });
});

describe("disclosure gates", () => {
  it("Knowledge work hides worktrees, thinking and tool-detail controls", () => {
    expect(shouldOfferWorktrees("knowledge")).toBe(false);
    expect(shouldOfferThinkingControls("knowledge")).toBe(false);
    expect(shouldOfferToolDetailControls("knowledge")).toBe(false);
    expect(effectiveShowThinking("knowledge", true)).toBe(false);
    expect(effectiveExpandCommandOutputs("knowledge", true)).toBe(false);
  });

  it("Coding shows them and honours user toggles (still default off)", () => {
    expect(shouldOfferWorktrees("coding")).toBe(true);
    expect(shouldOfferThinkingControls("coding")).toBe(true);
    expect(shouldOfferToolDetailControls("coding")).toBe(true);
    expect(effectiveShowThinking("coding", false)).toBe(false);
    expect(effectiveShowThinking("coding", true)).toBe(true);
    expect(effectiveExpandCommandOutputs("coding", false)).toBe(false);
    expect(effectiveExpandCommandOutputs("coding", true)).toBe(true);
  });
});

describe("continueChatDestinations", () => {
  it("Knowledge work → workspace only, no popup", () => {
    const dests = continueChatDestinations({
      purpose: "knowledge",
      isWorktree: false,
      worktreeSupported: true,
    });
    expect(dests.map((d) => d.id)).toEqual(["workspace"]);
    expect(continueChatNeedsPopup(dests)).toBe(false);
  });

  it("Coding + supported + not in worktree → workspace + worktree popup", () => {
    const dests = continueChatDestinations({
      purpose: "coding",
      isWorktree: false,
      worktreeSupported: true,
    });
    expect(dests.map((d) => d.id)).toEqual(["workspace", "worktree"]);
    expect(continueChatNeedsPopup(dests)).toBe(true);
  });

  it("collapses when worktrees unsupported or already in a worktree", () => {
    expect(
      continueChatNeedsPopup(
        continueChatDestinations({
          purpose: "coding",
          isWorktree: false,
          worktreeSupported: false,
        }),
      ),
    ).toBe(false);
    expect(
      continueChatNeedsPopup(
        continueChatDestinations({
          purpose: "coding",
          isWorktree: true,
          worktreeSupported: true,
        }),
      ),
    ).toBe(false);
  });
});

describe("PersistedState app purpose", () => {
  function fakeFs(files: Record<string, string> = {}): StateFs {
    return {
      existsSync: (p) => p in files,
      readFileSync: (p) => {
        if (!(p in files)) throw new Error("ENOENT");
        return files[p];
      },
      statSync: (p) => ({ size: (files[p] || "").length, mtimeMs: 1 }),
      writeFileSync: (p, data) => {
        files[p] = data;
      },
      renameSync: (from, to) => {
        files[to] = files[from];
        delete files[from];
      },
      mkdirSync: () => {},
    };
  }

  class FakeMemento implements MementoLike {
    private data = new Map<string, unknown>();
    get<T>(key: string, defaultValue?: T): T {
      if (this.data.has(key)) return this.data.get(key) as T;
      return defaultValue as T;
    }
    update(key: string, value: unknown): PromiseLike<void> {
      this.data.set(key, value);
      return Promise.resolve();
    }
  }

  it("is listed in DISK_KEYS as a global client-state file", () => {
    expect(DISK_KEYS[APP_PURPOSE_KEY]).toBe("app-purpose.json");
    expect(APP_PURPOSE_KEY).toBe("grok.appPurpose");
  });

  it("persists coding and reloads as coding on a second instance", async () => {
    const files: Record<string, string> = {};
    const fs = fakeFs(files);
    const dir = "/home/.grok/client-state";
    const first = new PersistedState(new FakeMemento(), dir, fs);
    await first.update(APP_PURPOSE_KEY, "coding");
    await first.flush();

    const second = new PersistedState(new FakeMemento(), dir, fs);
    expect(parseAppPurpose(second.get(APP_PURPOSE_KEY))).toBe("coding");
  });

  it("absent file reads as undefined → Knowledge work", () => {
    const state = new PersistedState(new FakeMemento(), "/home/.grok/client-state", fakeFs());
    expect(state.get(APP_PURPOSE_KEY)).toBeUndefined();
    expect(parseAppPurpose(state.get(APP_PURPOSE_KEY))).toBe("knowledge");
  });
});

