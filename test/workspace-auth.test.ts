/**
 * Shared workspace authorization + close-revocation helpers.
 *
 * Mutation-checked requirements (each fails when its production gate is reverted):
 *  1. remote send with no cwd refuses when bound session cwd is closed
 *  2. image handle under closed folder is refused
 *  3. held/adopted session cannot resume in a closed folder
 *  4. sidebar revoke on removeProjectFolder (source structure)
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authorizedListCwd,
  cwdIsAuthorized,
  filterEntriesByAuthorizedCwd,
  imageHandlesToRevoke,
  imagePathStillAuthorized,
  pathBoundToClosedFolder,
  sessionBoundToClosedFolder,
  sessionCwdFromGrokMediaPath,
} from "../src/workspace-auth";
import { pathsEqual } from "../src/worktree";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidebarSrc = () =>
  fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
const sessionStartSrc = () =>
  fs.readFileSync(path.join(root, "src", "session-start.ts"), "utf8");
const sessionCatalogSrc = () =>
  fs.readFileSync(path.join(root, "src", "session-catalog.ts"), "utf8");
const projectFoldersSrc = () =>
  fs.readFileSync(path.join(root, "src", "project-folders.ts"), "utf8");

describe("cwdIsAuthorized", () => {
  it("accepts only exact members of the authorized set", () => {
    const authorized = ["/work/a", "/work/a-wt"];
    expect(cwdIsAuthorized("/work/a", authorized, pathsEqual)).toBe(true);
    expect(cwdIsAuthorized("/work/a-wt", authorized, pathsEqual)).toBe(true);
    expect(cwdIsAuthorized("/work/closed", authorized, pathsEqual)).toBe(false);
    expect(cwdIsAuthorized(undefined, authorized, pathsEqual)).toBe(false);
    expect(cwdIsAuthorized("/work/a", [], pathsEqual)).toBe(false);
  });
});

describe("authorizedListCwd / filterEntriesByAuthorizedCwd (outbound send gate)", () => {
  it("refuses a closed project's cwd even when per-tab state still names it", () => {
    // Production: after revoke, RemoteClientState may leave cwd at the closed
    // path so selectRepo is required. Outbound builders must not scan that
    // catalog — they consult authorizedListCwd at build time.
    const open = ["/work/open"];
    const closed = "/work/closed";
    expect(authorizedListCwd(closed, open, pathsEqual)).toBeUndefined();
    expect(authorizedListCwd("/work/open", open, pathsEqual)).toBe("/work/open");
    expect(authorizedListCwd(undefined, open, pathsEqual)).toBeUndefined();
  });

  it("filters pinned/session entries so a closed repo never appears in the payload", () => {
    const authorized = ["/work/open"];
    const entries = [
      { id: "a", cwd: "/work/open", displayName: "ok" },
      { id: "b", cwd: "/work/closed", displayName: "leak" },
      { id: "c", cwd: undefined as string | undefined, displayName: "no-cwd" },
    ];
    const kept = filterEntriesByAuthorizedCwd(entries, authorized, pathsEqual);
    expect(kept.map((e) => e.id)).toEqual(["a"]);
  });

  it("mutation: trusting stale tab cwd without authorizedListCwd reopens the leak", () => {
    // Simulates a list builder using a stale cwd alone as the list scope
    // after a project close.
    const tabCwd = "/work/closed";
    const authorized = ["/work/open"];
    const buggyWouldScan = tabCwd; // old path: always scan tab cwd
    expect(buggyWouldScan).toBe("/work/closed");
    const fixed = authorizedListCwd(tabCwd, authorized, pathsEqual);
    expect(fixed).toBeUndefined(); // empty sessions list, no disk scan
  });
});

describe("image handle revocation", () => {
  it("lists handles whose paths sit under a closed folder", () => {
    const closed = path.resolve("/work/closed");
    const open = path.resolve("/work/open");
    const handles = new Map<string, string>([
      ["h1", path.join(closed, "shot.png")],
      ["h2", path.join(open, "ok.png")],
      ["h3", closed],
    ]);
    const revoked = imageHandlesToRevoke(handles, closed, pathsEqual);
    expect(revoked.sort()).toEqual(["h1", "h3"].sort());
  });

  it("refuses imagePathStillAuthorized for a closed-folder path", () => {
    const closed = path.resolve("/work/closed");
    const open = path.resolve("/work/open");
    const img = path.join(closed, "secret.png");
    expect(imagePathStillAuthorized(img, [open], { sameCwd: pathsEqual })).toBe(false);
    expect(imagePathStillAuthorized(img, [open, closed], { sameCwd: pathsEqual })).toBe(true);
  });

  it("allows grok session media only when the catalog cwd is still authorized", () => {
    const grokHome = path.resolve("/home/u/.grok");
    const repo = path.resolve("/work/open");
    const media = path.join(
      grokHome,
      "sessions",
      encodeURIComponent(repo),
      "images",
      "1.jpg",
    );
    expect(sessionCwdFromGrokMediaPath(media, grokHome)).toBe(repo);
    expect(
      imagePathStillAuthorized(media, [repo], {
        grokHome,
        sameCwd: pathsEqual,
        isTrustedGeneratedMedia: () => true,
      }),
    ).toBe(true);
    expect(
      imagePathStillAuthorized(media, [path.resolve("/work/other")], {
        grokHome,
        sameCwd: pathsEqual,
        isTrustedGeneratedMedia: () => true,
      }),
    ).toBe(false);
  });
});

describe("sessionBoundToClosedFolder / held resume", () => {
  it("matches process cwd and worktree bindings", () => {
    const closed = "/work/closed";
    expect(sessionBoundToClosedFolder(closed, undefined, undefined, closed, pathsEqual)).toBe(true);
    expect(
      sessionBoundToClosedFolder("/wt", "/wt", closed, closed, pathsEqual),
    ).toBe(true);
    expect(
      sessionBoundToClosedFolder("/work/open", undefined, undefined, closed, pathsEqual),
    ).toBe(false);
  });

  it("held session with closed cwd is not authorized (resume must refuse)", () => {
    const heldCwd = "/work/closed";
    const authorized = ["/work/open"];
    // Same predicate startSession / openSessionReserved use after close.
    expect(cwdIsAuthorized(heldCwd, authorized, pathsEqual)).toBe(false);
  });
});

describe("pathBoundToClosedFolder", () => {
  it("is segment-safe (not a string prefix)", () => {
    expect(pathBoundToClosedFolder("/work/closed-extra/x", "/work/closed", pathsEqual)).toBe(
      false,
    );
    expect(pathBoundToClosedFolder("/work/closed/x", "/work/closed", pathsEqual)).toBe(true);
  });
});

describe("sidebar close-revocation wiring (source)", () => {
  it("removeProjectFolder revokes sessions and image handles", () => {
    const src = sidebarSrc();
    expect(src).toContain("revokeClosedProjectFolder");
    expect(src).toContain("isAuthorizedCwd");
    expect(src).toContain("invalidateImageHandlesUnder");
    expect(src).toContain("isImagePathAuthorizedNow");

    const pfSrc = projectFoldersSrc();
    const removeStart = pfSrc.indexOf("async removeProjectFolder(");
    expect(removeStart).toBeGreaterThan(0);
    const removeEnd = pfSrc.indexOf("public sessionsBoundToFolder", removeStart);
    const removeBody = pfSrc.slice(removeStart, removeEnd);
    // Revoke must run after successful removeWorkspaceFolder, before UI rehome.
    expect(removeBody).toContain("revokeClosedProjectFolder(target)");
    expect(removeBody).toContain("removeWorkspaceFolder(target)");


    // startSession refuses unauthorized target.cwd even with resumeId.
    const startSrc = sessionStartSrc();
    const startStart = startSrc.indexOf("public async startSessionBody(");
    // A SEARCH BOUND, not a measurement: it only has to reach past the
    // method's prologue. 1200 stopped doing that the moment the open clock
    // added a few lines at the top, and the gate it looks for (at ~1460 chars)
    // read as deleted when it had merely moved. The body now lives in
    // session-start.ts; 4000 still clears the unauthorized-cwd refusal.
    const startBody = startSrc.slice(startStart, startStart + 4000);
    expect(startBody).toContain("isAuthorizedCwd(target.cwd)");
    expect(startBody).toContain("refused startSession");

    // requestImageOriginal revalidates.
    const inbound = fs.readFileSync(path.join(root, "src", "sidebar-inbound.ts"), "utf8");
    const imgStart = inbound.indexOf('case "requestImageOriginal"');
    const imgBody = inbound.slice(imgStart, imgStart + 800);
    expect(imgBody).toContain("isImagePathAuthorizedNow");

    // Mutation: if revoke is only a catalog refresh, the test fails.
    expect(removeBody).not.toMatch(
      /removeWorkspaceFolder\(target\)[\s\S]*return;\s*\n\s*const next/,
    );
  });

  it("single authorization query is consulted by start + list + image paths", () => {
    const src = sidebarSrc();
    // The shared query exists once.
    const queryDef = src.indexOf("private isAuthorizedCwd(");
    expect(queryDef).toBeGreaterThan(0);
    expect(src.indexOf("private isAuthorizedCwd(", queryDef + 1)).toBe(-1);
    // The list snapshot reads the same trusted set — not a second walk of the
    // open set, and not the catalog (which is wider).
    const snapshot = src.indexOf("private authorizedSessionCwds(");
    const snapshotBody = src.slice(snapshot, snapshot + 300);
    expect(snapshotBody).toContain("localTrustedSessionCwds");
    expect(snapshotBody).not.toContain("localRepoCatalogEntries");
  });

  it("every outbound list builder enforces authorizedListCwd at build time", () => {
    const cat = sessionCatalogSrc();
    // buildSessionsList: gate before disk scan.
    const listStart = cat.indexOf("buildSessionsList(");
    const listEnd = cat.indexOf("buildGrokSessionsList(", listStart);
    const listBody = cat.slice(listStart, listEnd > listStart ? listEnd : listStart + 800);
    expect(listBody).toContain("authorizedListCwd");
    expect(listBody).toContain("authorizedSessionCwds");
    // Empty list when unauthorized (no indexSessions for closed cwd).
    expect(listBody).toMatch(/type:\s*"sessions"/);
    expect(listBody).toContain("entries: []");

    // buildPinnedSessions: skip unauthorized pin buckets.
    const pinStart = cat.indexOf("buildPinnedSessions(");
    const pinEnd = cat.indexOf("postPinnedSessions(", pinStart);
    const pinBody = cat.slice(pinStart, pinEnd);
    expect(pinBody).toContain("authorizedListCwd");
    expect(pinBody).toContain("filterEntriesByAuthorizedCwd");

    // localRepoCatalogEntries remains the catalog source (open folders desktop).
    expect(cat).toContain("localRepoCatalogEntries");
  });


  it("toggleSessionPin refuses unauthorized home cwd (no protocol change)", () => {
    const src = sidebarSrc();
    const pinStart = src.indexOf("private async toggleSessionPin(");
    const pinEnd = src.indexOf("private buildPinnedSessions(", pinStart);
    const pinBody = src.slice(pinStart, pinEnd);
    expect(pinBody).toContain("isAuthorizedCwd(home)");
    // Must not mutate when home is only in cache/metadata after project close.
    expect(pinBody).toMatch(/if\s*\(\s*!this\.isAuthorizedCwd\(home\)\s*\)\s*return null/);
  });


  it("revokeClosedProjectFolder cancels voice for the closed folder", () => {
    const pfSrc = projectFoldersSrc();
    const revokeStart = pfSrc.indexOf("public revokeClosedProjectFolder(");
    const revokeBody = pfSrc.slice(revokeStart, revokeStart + 900);
    expect(revokeBody).toContain("revokeVoiceForClosedFolder");

    const voiceStart = pfSrc.indexOf("public revokeVoiceForClosedFolder(");
    expect(voiceStart).toBeGreaterThan(0);
    const voiceBody = pfSrc.slice(voiceStart, voiceStart + 1200);
    expect(voiceBody).toContain("stopVoiceInput");
    expect(voiceBody).toMatch(/getLocalVoiceCwd|localVoiceCwd/);
    expect(voiceBody).toMatch(/getLocalVoiceCredentialCwd|localVoiceCredentialCwd/);
  });
});
