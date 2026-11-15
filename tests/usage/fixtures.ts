import { createHash } from "node:crypto";
import type { UsageLease, UsageService } from "../../src/server/usage/service";
import { UsageError } from "../../src/server/usage/policy";
/** Explicitly non-billable unit fixtures. PostgreSQL tests verify actual accounting. */
export function mockLease(): UsageLease { return { id: "fixture", generationMs: 0, audioBytes: 0, async start() {}, async finish() {} }; }
export function memoryUsage(now = Date.now): UsageService {
  const entries = new Map<string, { source: string; at: number }>();
  const groups = new Map<string, { next: number; chars: number; closed: boolean; generationMs: number; audioBytes: number }>(); let active = false;
  return { async reserve(input) {
    if (active) throw new UsageError();
    const segment = input.segment ?? { index: 0, final: true, progressive: false, chars: 1 }, key = `${input.sessionId}:${input.requestId}`, id = `${key}:${segment.index}`;
    const digest = createHash("sha256").update(JSON.stringify([input.source, segment])).digest("hex");
    if (entries.has(id)) throw new UsageError(409, "USAGE_DUPLICATE", "Already attempted.");
    const group = groups.get(key) ?? { next: 0, chars: 0, closed: false, generationMs: 0, audioBytes: 0 };
    if (group.closed || group.next !== segment.index) throw new UsageError(409, "VOICE_SEGMENT_CONFLICT", "Out of order.");
    if (group.chars + segment.chars + (segment.index ? 1 : 0) > 800 || group.audioBytes >= 2_880_000) throw new UsageError();
    if ([...entries.values()].filter(row => now() - row.at < 60000).length >= 3 || entries.size >= 20) throw new UsageError();
    entries.set(id, { source: digest, at: now() }); group.chars += segment.chars + (segment.index ? 1 : 0); group.next++; groups.set(key, group); active = true;
    let done = false;
    return { id, generationMs: group.generationMs, audioBytes: group.audioBytes, async start() {}, async finish(_usage, result) {
      if (done) return; done = true; active = false;
      group.generationMs += result?.generationMs ?? 0; group.audioBytes += result?.audioBytes ?? 0;
      group.closed ||= !result?.completed || segment.final || segment.index === 2;
    } };
  } };
}
