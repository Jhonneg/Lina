import "server-only";
import { sql } from "drizzle-orm";
import { getDatabase } from "../db";
import { apiRateBuckets } from "../db/schema";
import { lockUsage } from "../usage/service";
import { ipDigest, UsageError } from "../usage/policy";
import { abusePolicy, type ApiKind } from "./policy";

export function createApiGuard(database = getDatabase, policyFactory = abusePolicy) {
  return {
    // IP admission runs before cookie lookup; a second session-only admission
    // follows successful lookup. No pool connection is held across that lookup.
    async take(request: Request, kind: ApiKind, sessionId?: string) {
      try {
        const policy = policyFactory();
        await database().transaction(async tx => {
          await lockUsage(tx);
          const clock = await tx.execute(sql`SELECT clock_timestamp() AS at`), now = new Date(clock.rows[0].at as string);
          const day = now.toISOString().slice(0, 10), minute = Math.floor(now.getTime() / 60000);
          const subject = sessionId ? `s:${sessionId}` : `ip:${ipDigest(request, policy.ip, now) ?? "local"}`;
          const limits = policy.limits[kind], minuteLimit = sessionId ? limits.sessionMinute : limits.ipMinute, dayLimit = sessionId ? limits.sessionDay : limits.ipDay;
          const untilDay = (Date.parse(`${day}T00:00:00Z`) + 86400000 - now.getTime()) / 1000;
          for (const [suffix, limit, retry] of [[`m:${minute}`, minuteLimit, 60 - now.getUTCSeconds()], [`d:${day}`, dayLimit, untilDay]] as const) {
            if (!limit) throw new UsageError(429, "API_RATE_LIMIT", "Request limit reached. Please try again later.", Math.ceil(retry));
            const rows = await tx.insert(apiRateBuckets).values({ key: `${kind}:${subject}:${suffix}`, count: 1, expiresAt: new Date(Date.parse(`${day}T00:00:00Z`) + 2 * 86400000) })
              .onConflictDoUpdate({ target: apiRateBuckets.key, set: { count: sql`${apiRateBuckets.count} + 1` }, where: sql`${apiRateBuckets.count} < ${limit}` }).returning({ count: apiRateBuckets.count });
            if (!rows.length) throw new UsageError(429, "API_RATE_LIMIT", "Request limit reached. Please try again later.", Math.max(1, Math.ceil(retry)));
          }
        });
      } catch (error) {
        if (error instanceof UsageError) throw error;
        throw new UsageError(503, "API_GUARD_UNAVAILABLE", "API protection is temporarily unavailable. Please try again later.", 30);
      }
    },
  };
}
export type ApiGuard = ReturnType<typeof createApiGuard>;
