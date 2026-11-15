import "server-only";
import { NextRequest } from "next/server";
import { createSessionService, sessionCookieSettings } from "../sessions";
import { RequestError } from "../chat-request";
import { UsageError } from "./policy";
export function sameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") throw new RequestError(403, "FORBIDDEN_ORIGIN", "A same-origin request is required.");
}
export async function billingSession(request: Request, service: Pick<ReturnType<typeof createSessionService>, "getExistingSession"> = createSessionService()) {
  sameOrigin(request);
  try {
    const cookies = new NextRequest(request.url, { headers: request.headers }).cookies;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(5000)]);
    const session = await new Promise<Awaited<ReturnType<typeof service.getExistingSession>>>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(new UsageError(503, "USAGE_UNAVAILABLE", "Session verification is temporarily unavailable.", 30)); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { abort(); return; }
      void service.getExistingSession(cookies.get(sessionCookieSettings().name)?.value).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
    if (!session) throw new RequestError(401, "SESSION_REQUIRED", "A valid anonymous session is required.");
    return session;
  } catch (error) { if (error instanceof RequestError) throw error; throw new UsageError(503, "USAGE_UNAVAILABLE", "Usage accounting is temporarily unavailable. Please try again later.", 30); }
}
export function requestKey(request: Request) {
  const key = request.headers.get("idempotency-key");
  if (!key || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) throw new UsageError(400, "USAGE_REQUEST_ID", "Provide an Idempotency-Key UUID for this billable request.", 0);
  return key;
}
