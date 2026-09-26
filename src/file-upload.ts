import * as path from "node:path";

const UUID_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type UploadRefs = Record<string, { uploadedFiles?: string[] } | undefined>;

function pathApi(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === "win32" ? path.win32 : path.posix;
}

function comparisonKey(p: string, platform: NodeJS.Platform): string {
  const resolved = pathApi(platform).resolve(p);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Return the owned UUID directory for exactly
 * `<stagingRoot>/<uuid>/<filename>`, never for a broader or escaped path. */
export function stagedUploadDirectory(
  stagingRoot: string,
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const api = pathApi(platform);
  const root = api.resolve(stagingRoot);
  const file = api.resolve(filePath);
  const rel = api.relative(comparisonKey(root, platform), comparisonKey(file, platform));
  if (!rel || api.isAbsolute(rel) || rel === ".." || rel.startsWith(".." + api.sep)) return undefined;
  const parts = rel.split(api.sep);
  if (parts.length !== 2 || !UUID_DIR_RE.test(parts[0]) || !parts[1]) return undefined;
  return api.join(root, parts[0]);
}

export function retainedUploadDirectories(
  stagingRoot: string,
  refs: UploadRefs,
  platform: NodeJS.Platform = process.platform,
): Set<string> {
  const out = new Set<string>();
  for (const meta of Object.values(refs)) {
    for (const file of meta?.uploadedFiles ?? []) {
      const dir = stagedUploadDirectory(stagingRoot, file, platform);
      if (dir) out.add(comparisonKey(dir, platform));
    }
  }
  return out;
}

/** Files owned only by the sessions being removed. Shared references (notably
 * source session + fork) remain live until the last referencing session goes. */
export function unreferencedUploadsForRemovedSessions(
  refs: UploadRefs,
  removedIds: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const removed = new Set(removedIds);
  const candidates = new Map<string, string>();
  const retained = new Set<string>();
  for (const [id, meta] of Object.entries(refs)) {
    for (const file of meta?.uploadedFiles ?? []) {
      const key = comparisonKey(file, platform);
      if (removed.has(id)) candidates.set(key, file);
      else retained.add(key);
    }
  }
  return [...candidates].filter(([key]) => !retained.has(key)).map(([, file]) => file);
}
