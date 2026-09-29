/** A focused collaborator test must fail if it crosses an unprovisioned seam. */
export function unwiredOps<T extends object>(): T {
  return new Proxy({} as T, {
    get(_target, key) {
      throw new Error(`Unprovisioned test operation: ${String(key)}`);
    },
  });
}
