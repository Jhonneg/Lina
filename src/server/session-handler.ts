import { hasSameOrigin } from "./request-origin";
import { stagingAccessFailure } from "./staging-access";
import "server-only";
import { createApiGuard, type ApiGuard } from "./abuse/guard";
import { UsageError } from "./usage/policy";
import { NextRequest, NextResponse } from "next/server";
import { createSessionService, sessionCookieSettings } from "./sessions";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function failure(status: number, code: string, message: string, retryAfter?: number) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, headers: { ...headers, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } });
}

export function createSessionHandler({ service = createSessionService(), production = process.env.NODE_ENV === "production", abuse = createApiGuard() }: {
  service?: Pick<ReturnType<typeof createSessionService>, "getOrCreateSession">;
  production?: boolean; abuse?: ApiGuard;
} = {}) {
  return async function POST(request: NextRequest) {
    const denied = stagingAccessFailure(request); if (denied) return denied;
    // Require an explicit matching public Origin, including behind OpenNext.
    if (!hasSameOrigin(request)) {
      return failure(403, "FORBIDDEN_ORIGIN", "A same-origin request is required.");
    }
    // Ignore caller-supplied IDs/body; only a validated cookie proves ownership.
    void request.body?.cancel().catch(() => {});
    try {
      await abuse.take(request, "session");
      const cookie = sessionCookieSettings(production);
      const result = await service.getOrCreateSession(request.cookies.get(cookie.name)?.value);
      await abuse.take(request, "session", result.session.id);
      const response = NextResponse.json({ ok: true, session: {
        id: result.session.id, expiresAt: result.session.expiresAt.toISOString(),
      } }, { headers });
      // Expires is authoritative: Next.js overwrites it when maxAge is also set.
      if (result.newToken) response.cookies.set({ ...cookie, value: result.newToken, expires: result.session.expiresAt });
      return response;
    } catch (error) {
      if (error instanceof UsageError) return failure(error.status, error.code, error.message, error.retryAfter);
      return failure(503, "SESSION_UNAVAILABLE", "Unable to initialize the session. Please try again later.");
    }
  };
}
