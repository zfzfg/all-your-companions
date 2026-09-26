import { describe, expect, it } from "vitest";
import {
  retainedUploadDirectories,
  stagedUploadDirectory,
  unreferencedUploadsForRemovedSessions,
} from "../src/file-upload";

describe("uploaded document lifetime", () => {
  const ROOT = "/storage/file-staging";
  const A = `${ROOT}/11111111-1111-4111-8111-111111111111/notes.md`;
  const B = `${ROOT}/22222222-2222-4222-8222-222222222222/report.pdf`;

  it("recognizes only the uuid-directory/filename staging shape", () => {
    expect(stagedUploadDirectory(ROOT, A, "linux"))
      .toBe(`${ROOT}/11111111-1111-4111-8111-111111111111`);
    expect(stagedUploadDirectory(ROOT, `${ROOT}/../outside/secret.md`, "linux")).toBeUndefined();
    expect(stagedUploadDirectory(ROOT, `${ROOT}/not-a-uuid/notes.md`, "linux")).toBeUndefined();
    expect(stagedUploadDirectory(ROOT, `${ROOT}/11111111-1111-4111-8111-111111111111/nested/notes.md`, "linux"))
      .toBeUndefined();
  });

  it("keeps every directory referenced by session metadata", () => {
    expect(retainedUploadDirectories(ROOT, {
      s1: { uploadedFiles: [A] },
      s2: { uploadedFiles: [A, B] },
    }, "linux")).toEqual(new Set([
      `${ROOT}/11111111-1111-4111-8111-111111111111`,
      `${ROOT}/22222222-2222-4222-8222-222222222222`,
    ]));
  });

  it("deletes a removed session's upload only when no remaining session/fork references it", () => {
    const meta = {
      source: { uploadedFiles: [A, B] },
      fork: { uploadedFiles: [A] },
    };
    expect(unreferencedUploadsForRemovedSessions(meta, ["source"], "linux")).toEqual([B]);
    expect(new Set(unreferencedUploadsForRemovedSessions(meta, ["source", "fork"], "linux")))
      .toEqual(new Set([A, B]));
  });
});
