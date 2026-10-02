export interface AdmissionPolicy { maxActiveTurns: number; minStartSpacingMs: number }
interface Waiter {
  policy: AdmissionPolicy;
  signal: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  abort: () => void;
}

/** One coordinator per extension host, shared by separate adapter processes. */
export class PromptAdmission {
  private active = 0;
  private lastStart?: number;
  private readonly queue: Waiter[] = [];
  private timer?: ReturnType<typeof setTimeout>;

  acquire(policy: AdmissionPolicy, signal: AbortSignal): Promise<() => void> {
    if (!Number.isSafeInteger(policy.maxActiveTurns) || policy.maxActiveTurns < 0
      || !Number.isSafeInteger(policy.minStartSpacingMs) || policy.minStartSpacingMs < 0)
      return Promise.reject(new Error("Invalid Antigravity admission configuration"));
    if (signal.aborted) return Promise.reject(new Error("Admission cancelled"));
    if (policy.maxActiveTurns === 0) return Promise.resolve(() => {});
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { policy, signal, resolve, reject, abort: () => {
        const index = this.queue.indexOf(waiter);
        if (index < 0) return;
        this.queue.splice(index, 1);
        signal.removeEventListener("abort", waiter.abort);
        reject(new Error("Admission cancelled"));
        this.drain();
      } };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.queue.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const next = this.queue[0];
    if (!next || this.active >= next.policy.maxActiveTurns) return;
    const wait = this.lastStart === undefined ? 0 : next.policy.minStartSpacingMs - (Date.now() - this.lastStart);
    if (wait > 0) { this.timer = setTimeout(() => this.drain(), wait); return; }
    this.queue.shift();
    next.signal.removeEventListener("abort", next.abort);
    this.active++;
    this.lastStart = Date.now();
    let released = false;
    next.resolve(() => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    });
    this.drain();
  }
}

export const antigravityAdmission = new PromptAdmission();
