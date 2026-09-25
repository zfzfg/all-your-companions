/**
 * Leaf types shared by the ACP client (`acp.ts`) and the backends
 * (`acp-backend.ts`, `*-backend.ts`). Imports nothing, so a backend can name
 * these without importing the client that imports it.
 */

export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode";

export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; path?: string };
