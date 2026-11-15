import "server-only";
import { createHash } from "node:crypto";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { getDatabase } from "../db";
import { sessions, usageReservations as rows, usageUtterances as groups } from "../db/schema";
import { UsageError, unavailable, usagePolicy, ipDigest, reserveEstimate, costMicro, type TokenUsage, type UsagePolicy } from "./policy";

export type UsageTransaction = Parameters<Parameters<ReturnType<typeof getDatabase>["transaction"]>[0]>[0];
export type UsageLease = { id: string; generationMs: number; audioBytes: number; start(): Promise<void>;
  finish(usage?: TokenUsage, speech?: { completed: boolean; generationMs: number; audioBytes: number }): Promise<void> };
export type UsageInput = { request: Request; sessionId: string; requestId: string; kind: "text" | "speech"; model: string; source: string;
  segment?: { index: number; final: boolean; progressive: boolean; chars: number } };
export const lockUsage = async (tx: UsageTransaction) => {
  await tx.execute(sql`SET LOCAL statement_timeout = '5000'`); await tx.execute(sql`SET LOCAL lock_timeout = '3000'`);
  // One short global admission lock serializes budget and concurrency checks across processes.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(761915041)`);
};
export function createUsageService(database = getDatabase, policyFactory = usagePolicy) {
  async function transaction<T>(work: (tx: UsageTransaction) => Promise<T>, tx?: UsageTransaction) {
    try { return tx ? await work(tx) : await database().transaction(work); }
    catch (error) { if (error instanceof UsageError) throw error; throw unavailable(); }
  }
  return {
    async reserve(input: UsageInput, existingTx?: UsageTransaction): Promise<UsageLease> {
      const policy: UsagePolicy = policyFactory();
      const estimate = reserveEstimate(input.kind, input.source, policy);
      if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.requestId)) throw new UsageError(400, "USAGE_REQUEST_ID", "A stable request UUID is required.", 0);
      const segment = input.segment?.index ?? 0;
      if (!Number.isInteger(segment) || segment < 0 || segment > 2) throw new UsageError(400, "INVALID_REQUEST", "Invalid speech segment.", 0);
      const fingerprint = createHash("sha256").update(JSON.stringify([input.model, input.source, input.segment ?? null])).digest("hex");
      const receipt = await transaction(async tx => {
        await lockUsage(tx);
        const clock = await tx.execute(sql`SELECT clock_timestamp() AS at`);
        const now = new Date(clock.rows[0].at as string), day = new Date(now.getTime()); day.setUTCHours(0, 0, 0, 0);
        const hour = new Date(now.getTime() - 3_600_000), minute = new Date(now.getTime() - 60_000);
        await tx.update(rows).set({ state: "voided", chargedMicro: 0, finishedAt: now }).where(and(eq(rows.state, "reserved"), isNull(rows.startedAt), sql`${rows.leaseUntil} <= ${now}`));
        const digest = ipDigest(input.request, policy, now);
        const [session] = await tx.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, input.sessionId), sql`${sessions.expiresAt} > ${now}`)).limit(1);
        if (!session) throw new UsageError(401, "SESSION_REQUIRED", "A valid session is required.", 0);
        const [previous] = await tx.select().from(rows).where(and(eq(rows.sessionId, input.sessionId), eq(rows.requestId, input.requestId), eq(rows.kind, input.kind), eq(rows.segment, segment))).limit(1);
        if (previous) throw new UsageError(409, previous.fingerprint === fingerprint ? "USAGE_DUPLICATE" : "USAGE_CONFLICT", "This request was already attempted. Reuse its saved result or submit a new request explicitly.", 0);
        const [totals] = await tx.select({
          hour: sql<number>`count(*) filter (where ${rows.createdAt} >= ${hour})::int`,
          day: sql<number>`count(*)::int`, minute: sql<number>`count(*) filter (where ${rows.createdAt} >= ${minute})::int`,
        }).from(rows).where(and(eq(rows.sessionId, input.sessionId), eq(rows.kind, input.kind), gte(rows.createdAt, new Date(Math.min(hour.getTime(), day.getTime())))));
        // Count the UTC day independently when the rolling hour crosses midnight.
        const [daily] = await tx.select({ count: sql<number>`count(*)::int` }).from(rows).where(and(eq(rows.sessionId, input.sessionId), eq(rows.kind, input.kind), gte(rows.createdAt, day)));
        if (totals.hour >= (input.kind === "text" ? policy.textHour : policy.speechHour)) throw new UsageError(429, "USAGE_HOURLY", "Hourly usage limit reached. Please try again later.", 3600);
        if (daily.count >= (input.kind === "text" ? policy.textDay : policy.speechDay)) throw new UsageError(429, "USAGE_DAILY", "Daily usage limit reached. Please try again tomorrow.", Math.ceil((day.getTime() + 86_400_000 - now.getTime()) / 1000));
        if (input.kind === "speech" && totals.minute >= policy.speechMinute) throw new UsageError();
        if (digest) {
          const [ip] = await tx.select({ hour: sql<number>`count(*)::int`, minute: sql<number>`count(*) filter (where ${rows.createdAt} >= ${minute})::int` }).from(rows).where(and(eq(rows.ipHash, digest), gte(rows.createdAt, hour)));
          if (ip.minute >= policy.ipMinute || ip.hour >= policy.ipHour) throw new UsageError(429, "USAGE_IP_LIMIT", "Request limit reached. Please wait before trying again.", ip.minute >= policy.ipMinute ? 60 : 3600);
        }
        const [active] = await tx.select({ all: sql<number>`count(*)::int`, session: sql<number>`count(*) filter (where ${rows.sessionId} = ${input.sessionId})::int` }).from(rows).where(and(eq(rows.state, "reserved"), sql`${rows.leaseUntil} > ${now}`));
        if (active.all >= policy.globalConcurrent || active.session >= policy.sessionConcurrent) throw new UsageError(429, "USAGE_BUSY", "Generation is busy. Please try again shortly.", 5);
        const [budget] = await tx.select({ used: sql<string>`coalesce(sum(${rows.chargedMicro}), 0)::text` }).from(rows).where(gte(rows.createdAt, day));
        if (Number(budget.used) + estimate.micro > policy.budgetMicro) throw new UsageError(429, "USAGE_BUDGET", "The shared daily usage budget has been reached. Please try again tomorrow.", Math.ceil((day.getTime() + 86_400_000 - now.getTime()) / 1000));
        let group: typeof groups.$inferSelect | undefined;
        if (input.kind === "speech") {
          const part = input.segment ?? { index: 0, final: true, progressive: false, chars: 0 };
          [group] = await tx.select().from(groups).where(and(eq(groups.sessionId, input.sessionId), eq(groups.requestId, input.requestId))).limit(1);
          if ((!group && segment !== 0) || (group && (group.closed || group.nextSegment !== segment || group.progressive !== part.progressive || now.getTime() - group.createdAt.getTime() > 90_000))) throw new UsageError(409, "VOICE_SEGMENT_CONFLICT", "This speech sequence is closed, expired or out of order.", 0);
          if (group && segment > 0) {
            const [prior] = await tx.select({ state: rows.state, finishedAt: rows.finishedAt }).from(rows).where(and(eq(rows.sessionId, input.sessionId), eq(rows.requestId, input.requestId), eq(rows.kind, "speech"), eq(rows.segment, segment - 1)));
            if (!prior?.finishedAt || prior.state === "reserved") throw new UsageError(409, "VOICE_SEGMENT_CONFLICT", "The previous speech segment has not completed.", 0);
          }
          if (!Number.isInteger(part.chars) || part.chars < 1 || (group?.chars ?? 0) + part.chars + (segment ? 1 : 0) > 800 || (group?.generationMs ?? 0) >= 30_000 || (group?.audioBytes ?? 0) >= 2_880_000) throw new UsageError(429, "VOICE_BUDGET", "The cumulative speech budget for this response has been reached.", 60);
          if (!group) [group] = await tx.insert(groups).values({ sessionId: input.sessionId, requestId: input.requestId, progressive: part.progressive }).returning();
          await tx.update(groups).set({ chars: group.chars + part.chars + (segment ? 1 : 0), nextSegment: segment + 1 }).where(eq(groups.id, group.id));
        }
        const [record] = await tx.insert(rows).values({ sessionId: input.sessionId, requestId: input.requestId, segment, kind: input.kind, fingerprint,
          ipHash: digest, model: input.model, pricing: estimate.pricing, reservedMicro: estimate.micro, chargedMicro: estimate.micro,
          createdAt: now, leaseUntil: new Date(now.getTime() + 90_000) }).returning();
        return { id: record.id, group, final: input.segment?.final ?? true };
      }, existingTx);
      return {
        id: receipt.id, generationMs: receipt.group?.generationMs ?? 0, audioBytes: receipt.group?.audioBytes ?? 0,
        async start() {
          await transaction(async tx => {
            await lockUsage(tx);
            const [record] = await tx.update(rows).set({ startedAt: sql`clock_timestamp()` }).where(and(eq(rows.id, receipt.id), eq(rows.state, "reserved"), isNull(rows.startedAt), sql`${rows.leaseUntil} > clock_timestamp()`)).returning({ id: rows.id });
            if (!record) throw new UsageError(409, "USAGE_DUPLICATE", "This request cannot start again.", 0);
          });
        },
        async finish(usage, speech) {
          await transaction(async tx => {
            await lockUsage(tx);
            const [record] = await tx.select().from(rows).where(eq(rows.id, receipt.id)).limit(1);
            if (!record) return; // A surrounding persistence transaction may have rolled back before dispatch.
            if (record.state !== "reserved") return;
            const actual = record.startedAt ? usage : { input: 0, cached: 0, output: 0, audio: 0 };
            const charge = actual ? costMicro(actual, record.pricing) : record.reservedMicro;
            await tx.update(rows).set({ chargedMicro: charge, state: !record.startedAt ? "voided" : actual ? "settled" : "uncertain", actualUsage: actual ?? null, finishedAt: sql`clock_timestamp()` }).where(eq(rows.id, record.id));
            if (receipt.group) {
              const [group] = await tx.select().from(groups).where(eq(groups.id, receipt.group.id));
              if (group) await tx.update(groups).set({ generationMs: group.generationMs + Math.max(0, Math.ceil(speech?.generationMs ?? 0)), audioBytes: group.audioBytes + Math.max(0, Math.ceil(speech?.audioBytes ?? 0)),
                closed: group.closed || !speech?.completed || receipt.final || record.segment === 2 || group.chars >= 800 }).where(eq(groups.id, group.id));
            }
          });
        },
      };
    },
  };
}
export type UsageService = ReturnType<typeof createUsageService>;
