import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const ACCESS_TTL_SECONDS = 8 * 60 * 60;
type Env = Record<string, string | undefined>;
export function accessPolicy(env: Env = process.env) {
  // Public release must be deliberate; an unset production mode is restricted.
  const mode = env.STAGING_ACCESS_MODE ?? (env.NODE_ENV === "production" ? "restricted" : "disabled");
  if (mode === "disabled") return { restricted: false as const, secret: "" };
  const secret = env.STAGING_ACCESS_SECRET ?? "";
  if (mode !== "restricted" || !/^[a-f0-9]{64}$/i.test(secret) || /^(.)\1+$/.test(secret)) throw new Error("Staging access is unavailable.");
  return { restricted: true as const, secret };
}
export function accessCookie(production = process.env.NODE_ENV === "production") {
  return { name: production ? "__Host-lain_staging" : "lain_staging", httpOnly: true, secure: production, sameSite: "lax" as const, path: "/" };
}
function signature(payload: string, secret: string) {
  return createHmac("sha256", Buffer.from(secret, "hex")).update(`lain-staging-operator:${payload}`).digest("hex");
}
export function createAccessToken(secret: string, now = Date.now()) {
  const payload = `v1.${Math.floor(now / 1000)}.${randomBytes(16).toString("hex")}`;
  return `${payload}.${signature(payload, secret)}`;
}
export function validAccessToken(token: string | undefined, secret: string, now = Date.now()) {
  if (!token || token.length > 160 || !/^v1\.\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) return false;
  const [version, issued, nonce, mac] = token.split(".");
  const issuedAt = Number(issued), time = Math.floor(now / 1000);
  if (issuedAt > time || time >= issuedAt + ACCESS_TTL_SECONDS) return false;
  return timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(signature(`${version}.${issued}.${nonce}`, secret), "hex"));
}
export function matchesAccessSecret(candidate: string, secret: string) {
  return timingSafeEqual(createHash("sha256").update(candidate).digest(), createHash("sha256").update(secret).digest());
}
export function accessStatus(request: Request) {
  const policy = accessPolicy();
  return { restricted: policy.restricted, authorized: !policy.restricted || validAccessToken(
    new NextRequest(request.url, { headers: request.headers }).cookies.get(accessCookie().name)?.value, policy.secret) };
}
export function accessError(status: number, code: string, message: string, retryAfter?: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } });
}
/** Must be called directly inside handlers, before session/DB/provider access. */
export function stagingAccessFailure(request: Request): NextResponse | null {
  try {
    if (accessStatus(request).authorized) return null;
    return accessError(401, "STAGING_ACCESS_REQUIRED", "Conversational features are temporarily unavailable to visitors.");
  } catch { return accessError(503, "STAGING_ACCESS_UNAVAILABLE", "Conversational features are temporarily unavailable."); }
}
