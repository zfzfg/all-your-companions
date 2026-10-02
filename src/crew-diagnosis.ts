/**
 * One line for a crew or subagent transition.
 *
 * The line carries ids and a short reason. It does not carry a prompt, a
 * bearer token, or file contents. Callers pass the reason they already
 * intend to log; this only redacts secrets that slipped into it.
 */

const SECRET = /(?:bearer\s+)[a-z0-9._~+/-]+=*|COMPANIONS_DELEGATE_TOKEN=\S+|sk-[a-z0-9]{8,}/gi;

export interface CrewDiagnosisEvent {
  runId: string;
  branchId?: string;
  attemptId?: string;
  seq: number;
  reason: string;
}

export function redactDiagnosis(text: string): string {
  return String(text ?? "").replace(SECRET, (match) => match.startsWith("COMPANIONS") ? "COMPANIONS_DELEGATE_TOKEN=[redacted]" : "[redacted]").slice(0, 300);
}

export function diagnosisLine(event: CrewDiagnosisEvent): string {
  const branch = event.branchId ? ` branch=${event.branchId}` : "";
  const attempt = event.attemptId ? ` attempt=${event.attemptId}` : "";
  return `[crew] run=${event.runId}${branch}${attempt} seq=${event.seq} ${redactDiagnosis(event.reason)}`;
}
