import type { ContextQuality, ContextRuntime, ContextUsageSemantics, ModelContextLimits } from "./context-budget";

/** Provider-specific parsers supply semantics; arbitrary vendor fields never do. */
export interface NativeContextObservation {
  limits?: ModelContextLimits;
  limitQuality?: ContextQuality;
  used?: number;
  usageQuality?: ContextQuality;
  usageSemantics: ContextUsageSemantics;
  runtime?: ContextRuntime;
  /** Retained only during normalization; never sent to UI or persisted. */
  native?: unknown;
}
