import "server-only";
import { getContext } from "@netlify/functions";

/** OpenNext may reconstruct an internal URL; never trust forwarded host headers. */
export function hasSameOrigin(request: Request, allowMissing = false, env: Record<string, string | undefined> = process.env) {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;
  let expected: string;
  try {
    if (env.USAGE_TRUSTED_PROXY === "netlify") {
      const siteUrl = getContext().site.url;
      if (!siteUrl) return false;
      const url = new URL(siteUrl);
      // Netlify's site URL is exposed as HTTP in the Functions context even
      // when the public site is served over HTTPS.
      if (url.protocol !== "http:" && url.protocol !== "https:") return false;
      if (url.username || url.password) return false;
      url.protocol = "https:";
      expected = url.origin;
    } else {
      expected = new URL(request.url).origin;
    }
  } catch {
    return false; // Missing platform context/configuration must never relax CSRF.
  }
  const origin = request.headers.get("origin");
  return (allowMissing && origin === null) || origin === expected;
}
