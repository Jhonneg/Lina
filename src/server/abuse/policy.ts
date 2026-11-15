import "server-only";
import { trustedIpPolicy, UsageError } from "../usage/policy";
export type ApiKind = "session" | "create" | "read" | "mutate";
export function abusePolicy(env: Record<string, string | undefined> = process.env) {
  const integer = (name: string, fallback: number, max = 100000) => {
    const value = env[name]?.trim() ? Number(env[name]) : fallback;
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new UsageError(503, "API_GUARD_UNAVAILABLE", "API protection is temporarily unavailable.", 30);
    return value;
  };
  const limits = (kind: ApiKind, ipMinute: number, ipDay: number, sessionMinute: number, sessionDay: number) => ({
    ipMinute: integer(`API_${kind.toUpperCase()}_IP_MINUTE`, ipMinute), ipDay: integer(`API_${kind.toUpperCase()}_IP_DAY`, ipDay),
    sessionMinute: integer(`API_${kind.toUpperCase()}_SESSION_MINUTE`, sessionMinute), sessionDay: integer(`API_${kind.toUpperCase()}_SESSION_DAY`, sessionDay),
  });
  return { ip: trustedIpPolicy(env), limits: {
    session: limits("session", 20, 200, 20, 200), create: limits("create", 10, 100, 5, 50),
    read: limits("read", 120, 2000, 60, 1000), mutate: limits("mutate", 30, 300, 15, 150),
  }, conversations: integer("STORAGE_CONVERSATIONS_PER_SESSION", 50), messages: integer("STORAGE_MESSAGES_PER_SESSION", 1000),
    retentionDays: integer("SESSION_EXPIRED_RETENTION_DAYS", 7, 365), cleanupBatch: Math.max(1, integer("API_CLEANUP_BATCH", 100, 1000)) };
}
