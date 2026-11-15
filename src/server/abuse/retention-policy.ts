/** Shared by the server-only maintenance CLI and Netlify scheduled function. */
export function retentionPolicy(env: Record<string, string | undefined> = process.env) {
  const integer = (name: string, fallback: number, max: number) => {
    const value = env[name]?.trim() ? Number(env[name]) : fallback;
    if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error("Invalid retention configuration.");
    return value;
  };
  return { retentionDays: integer("SESSION_EXPIRED_RETENTION_DAYS", 7, 365),
    cleanupBatch: Math.max(1, integer("API_CLEANUP_BATCH", 100, 1000)) };
}
