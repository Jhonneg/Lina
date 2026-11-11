import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createSessionService, sessionCookieSettings } from "./sessions";

const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
function failure(status: number, code: string, message: string) {
  return NextResponse.json({ ok: false, error: { code, message } }, { status, headers });
}

export function createSessionHandler({ service = createSessionService(), production = process.env.NODE_ENV === "production" }: {
  service?: Pick<ReturnType<typeof createSessionService>, "getOrCreateSession">;
  production?: boolean;
} = {}) {
  return async function POST(request: NextRequest) {
    // Require an explicit matching Origin. Do not trust forwarded host headers.
    if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") {
      return failure(403, "FORBIDDEN_ORIGIN", "A same-origin request is required.");
    }
    // Ignore caller-supplied IDs/body; only a validated cookie proves ownership.
    void request.body?.cancel().catch(() => {});
    try {
      const cookie = sessionCookieSettings(production);
      const result = await service.getOrCreateSession(request.cookies.get(cookie.name)?.value);
      const response = NextResponse.json({ ok: true, session: {
        id: result.session.id, expiresAt: result.session.expiresAt.toISOString(),
      } }, { headers });
      // Expires is authoritative: Next.js overwrites it when maxAge is also set.
      if (result.newToken) response.cookies.set({ ...cookie, value: result.newToken, expires: result.session.expiresAt });
      return response;
    } catch {
      return failure(503, "SESSION_UNAVAILABLE", "Unable to initialize the session. Please try again later.");
    }
  };
}
