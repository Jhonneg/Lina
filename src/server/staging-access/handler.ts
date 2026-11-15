import { hasSameOrigin } from "../request-origin";
import "server-only";
import { NextResponse } from "next/server";
import { createApiGuard, type ApiGuard } from "../abuse/guard";
import { UsageError } from "../usage/policy";
import { RequestError, validateHeaders } from "../chat-request";
import { ACCESS_TTL_SECONDS, accessCookie, accessError, accessPolicy, accessStatus, createAccessToken, matchesAccessSecret } from "./index";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
async function credentials(request: Request) {
  validateHeaders(request);
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > 1024) throw new RequestError(413, "PAYLOAD_TOO_LARGE", "Request is too large.");
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]), reader = request.body?.getReader();
  if (!reader) throw new RequestError(400, "INVALID_REQUEST", "Provide access credentials.");
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const buffer = new Uint8Array(1024); let size = 0;
  try {
    while (true) {
      signal.throwIfAborted(); const chunk = await reader.read(); signal.throwIfAborted(); if (chunk.done) break;
      if (size + chunk.value.byteLength > buffer.length) throw new RequestError(413, "PAYLOAD_TOO_LARGE", "Request is too large.");
      buffer.set(chunk.value, size); size += chunk.value.byteLength;
    }
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size))); }
    catch { throw new RequestError(400, "INVALID_REQUEST", "Provide valid access credentials."); }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => k !== "secret") ||
        typeof (value as { secret?: unknown }).secret !== "string" || (value as { secret: string }).secret.length > 128) {
      throw new RequestError(400, "INVALID_REQUEST", "Provide valid access credentials.");
    }
    return (value as { secret: string }).secret;
  } finally { signal.removeEventListener("abort", abort); abort(); reader.releaseLock(); }
}
export function createStagingAccessHandlers({ abuse = createApiGuard() }: { abuse?: ApiGuard } = {}) {
  return {
    GET(request: Request) {
      try { return Response.json({ ok: true, ...accessStatus(request) }, { headers }); }
      catch { return accessError(503, "STAGING_ACCESS_UNAVAILABLE", "Conversational features are temporarily unavailable."); }
    },
    async POST(request: Request) {
      if (process.env.NODE_ENV === "production" && new URL(request.url).protocol !== "https:") return accessError(403, "HTTPS_REQUIRED", "Use HTTPS for operator access.");
      if (!hasSameOrigin(request)) return accessError(403, "FORBIDDEN_ORIGIN", "A same-origin request is required.");
      try {
        const policy = accessPolicy();
        if (!policy.restricted) return accessError(404, "NOT_FOUND", "Not found.");
        const candidate = await credentials(request);
        // Intentional public authentication admission only; no sessions or provider calls.
        // Shared PostgreSQL counters survive processes and cookie/session rotation.
        await abuse.take(request, "access");
        if (!matchesAccessSecret(candidate, policy.secret)) return accessError(401, "STAGING_ACCESS_REQUIRED", "Invalid access credentials.");
        const now = Date.now(), response = NextResponse.json({ ok: true, expiresAt: new Date(now + ACCESS_TTL_SECONDS * 1000).toISOString() }, { headers });
        response.cookies.set({ ...accessCookie(), value: createAccessToken(policy.secret, now), maxAge: ACCESS_TTL_SECONDS });
        return response;
      } catch (error) {
        if (error instanceof UsageError) return accessError(error.status, error.code, error.message, error.retryAfter);
        if (error instanceof RequestError) return accessError(error.status, error.code, error.message);
        return accessError(503, "STAGING_ACCESS_UNAVAILABLE", "Staging access is temporarily unavailable.");
      }
    },
    DELETE(request: Request) {
      if (!hasSameOrigin(request)) return accessError(403, "FORBIDDEN_ORIGIN", "A same-origin request is required.");
      const response = NextResponse.json({ ok: true }, { headers });
      response.cookies.set({ ...accessCookie(), value: "", maxAge: 0 });
      return response;
    },
  };
}
