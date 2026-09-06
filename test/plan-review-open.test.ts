import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSafePlanReviewFileName,
  isSafeRelativePlanReviewLink,
  isTrustedPlanReviewPath,
  planReviewSessionDirectoryName,
} from "../src/plan-review";

describe("plan-review path fence", () => {
  it("accepts only a session segment and one Markdown file", () => {
    expect(isSafeRelativePlanReviewLink("session-id/no-op.md")).toBe(true);
    expect(isSafeRelativePlanReviewLink("session-id/NO-OP.MD")).toBe(true);
    expect(isSafeRelativePlanReviewLink("session-id/sub/no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("../session-id/no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("session-id/../no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("session-id/no-op.txt")).toBe(false);
    expect(isSafeRelativePlanReviewLink("C:\\outside\\no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("\\\\server\\share\\no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("file:///outside/no-op.md")).toBe(false);
    expect(isSafeRelativePlanReviewLink("session-id/no-op.md\0")).toBe(false);
  });

  it("accepts only one Markdown file below a conversation-scoped root", () => {
    expect(isSafePlanReviewFileName("no-op.md")).toBe(true);
    expect(isSafePlanReviewFileName("NO-OP.MD")).toBe(true);
    expect(isSafePlanReviewFileName("session-id/no-op.md")).toBe(false);
    expect(isSafePlanReviewFileName("../no-op.md")).toBe(false);
    expect(isSafePlanReviewFileName("no-op.txt")).toBe(false);
    expect(isSafePlanReviewFileName("C:\\outside\\no-op.md")).toBe(false);
    expect(isSafePlanReviewFileName("file:no-op.md")).toBe(false);
    expect(isSafePlanReviewFileName("no-op.md\0")).toBe(false);
  });

  it("derives the same bounded conversation directory segment used by snapshots", () => {
    expect(planReviewSessionDirectoryName("Conversation A / ..")).toBe("conversation-a-..");
    expect(planReviewSessionDirectoryName("x".repeat(100))).toHaveLength(80);
  });

  it("requires existence before and after canonicalisation", () => {
    const root = path.join(path.resolve("."), "plan-review-root", "session-id");
    const candidate = path.join(root, "no-op.md");
    const existing = new Set([candidate]);
    const realpath = (p: string) => path.resolve(p);

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(true);
    expect(
      isTrustedPlanReviewPath(path.join(root, "..", "no-op.md"), root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);

    existing.clear();
    existing.add(candidate);
    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath: (p) => path.join(path.dirname(root), "canonical-missing.md"),
      }),
    ).toBe(false);
  });

  it("refuses a plan file symlink that leaves plan-reviews", () => {
    const root = path.join(path.resolve("."), "plan-review-root", "session-id");
    const candidate = path.join(root, "no-op.md");
    const outside = path.join(path.dirname(path.dirname(root)), "secret.md");
    const existing = new Set([candidate, outside]);
    const realpath = (p: string) => (path.resolve(p) === path.resolve(candidate) ? outside : path.resolve(p));

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("refuses a relocated plan-reviews directory", () => {
    const storage = path.join(path.resolve("."), "global-storage");
    const reviews = path.join(storage, "plan-reviews");
    const root = path.join(reviews, "session-id");
    const candidate = path.join(root, "no-op.md");
    const relocated = path.join(path.dirname(storage), "other-storage", "plan-reviews");
    const existing = new Set([candidate, path.join(relocated, "session-id", "no-op.md")]);
    const realpath = (p: string) => {
      const resolved = path.resolve(p);
      return resolved === path.resolve(reviews) || resolved.startsWith(path.resolve(reviews) + path.sep)
        ? path.join(relocated, path.relative(reviews, resolved))
        : resolved;
    };

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("refuses a session-directory link to a sibling session", () => {
    const reviews = path.join(path.resolve("."), "plan-review-root");
    const root = path.join(reviews, "session-a");
    const candidate = path.join(root, "no-op.md");
    const sibling = path.join(reviews, "session-b", "no-op.md");
    const existing = new Set([candidate, sibling]);
    const realpath = (p: string) => {
      const resolved = path.resolve(p);
      const session = root;
      return resolved === session || resolved.startsWith(session + path.sep)
        ? path.join(reviews, "session-b", path.relative(session, resolved))
        : resolved;
    };

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });

  it("refuses a file link to another file even within the same session", () => {
    const root = path.join(path.resolve("."), "plan-review-root", "session-id");
    const candidate = path.join(root, "no-op.md");
    const other = path.join(root, "other.md");
    const existing = new Set([candidate, other]);
    const realpath = (p: string) => path.resolve(p) === path.resolve(candidate) ? other : path.resolve(p);

    expect(
      isTrustedPlanReviewPath(candidate, root, {
        exists: (p) => existing.has(p),
        realpath,
      }),
    ).toBe(false);
  });
});
