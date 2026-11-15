/** Development-only, bounded numeric diagnostics. Never records speech or conversation text. */
export type VoiceDiagnostic = { event: string; at: number; [key: string]: string | number | boolean };
const events: VoiceDiagnostic[] = [];
export function voiceTrace(event: string, data: Record<string, string | number | boolean> = {}) {
  if (process.env.NODE_ENV !== "development") return;
  events.push({ ...data, event, at: performance.now() });
  if (events.length > 1000) events.shift();
  if (typeof window !== "undefined") {
    (window as typeof window & { __lainVoiceDiagnostics?: typeof events }).__lainVoiceDiagnostics = events;
  }
}
