/**
 * What an integration did to one target checkout.
 *
 * Workers do not apply themselves. A queue per checkout copies successful
 * results in order. A conflict or a refusal stops that checkout and names
 * the files already copied.
 */

export type CrewApplyOutcome =
  | { kind: "applied"; files: string[] }
  | { kind: "unchanged"; files: string[] }
  | { kind: "conflict"; files: string[] }
  | { kind: "declined"; files: string[] }
  | { kind: "failed"; message: string; appliedFiles: string[] };

export function crewApplyFiles(outcome: CrewApplyOutcome): string[] {
  return outcome.kind === "failed" ? outcome.appliedFiles : outcome.files;
}

/** A legacy `void` apply (a test double) counts as applied with no file list. */
export function normalizeCrewApplyOutcome(result: unknown): CrewApplyOutcome {
  if (result && typeof result === "object" && "kind" in result) {
    const kind = (result as { kind?: unknown }).kind;
    const record = result as { files?: unknown; appliedFiles?: unknown; message?: unknown };
    if (kind === "applied" || kind === "unchanged" || kind === "conflict" || kind === "declined") {
      const files = Array.isArray(record.files) ? record.files.map((file) => String(file)) : [];
      return { kind, files };
    }
    if (kind === "failed") {
      const message = String(record.message ?? "apply failed");
      const appliedFiles = Array.isArray(record.appliedFiles) ? record.appliedFiles.map((file) => String(file)) : [];
      return { kind: "failed", message, appliedFiles };
    }
  }
  return { kind: "applied", files: [] };
}

/**
 * Serializes integration of one checkout. A second caller waits until the
 * first has finished, including when the first threw.
 */
export class IntegrationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(checkout: string, fn: () => Promise<T>): Promise<T> {
    const key = checkout || ".";
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn, fn);
    this.tails.set(key, result.then(() => undefined, () => undefined));
    return result;
  }
}
