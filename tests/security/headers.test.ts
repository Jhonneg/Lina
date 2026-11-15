import assert from "node:assert/strict";
import { test } from "node:test";
import nextConfig from "../../next.config";

async function configuredHeaders(production: boolean) {
  const env = process.env as Record<string, string | undefined>, previous = env.NODE_ENV;
  try {
    env.NODE_ENV = production ? "production" : "development";
    const rules = await nextConfig.headers!();
    assert.equal(rules.length, 1); assert.equal(rules[0].source, "/:path*");
    return new Map(rules[0].headers.map(({ key, value }) => [key, value]));
  } finally { if (previous === undefined) delete env.NODE_ENV; else env.NODE_ENV = previous; }
}

test("production security headers cover documents and APIs without exposing speech permissions", async () => {
  const headers = await configuredHeaders(true), csp = headers.get("Content-Security-Policy")!;
  for (const directive of ["default-src 'self'", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "worker-src 'none'"]) assert.ok(csp.split("; ").includes(directive));
  assert.ok(!csp.includes("unsafe-eval") && !csp.includes("https:") && !csp.includes("ws:"));
  assert.equal(headers.get("X-Frame-Options"), "DENY"); assert.equal(headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(headers.get("Permissions-Policy"), "camera=(), microphone=(), geolocation=()");
  assert.equal(nextConfig.poweredByHeader, false);
});

test("CSP preserves cached Next bootstrap, R3F styles and local PCM; eval and HMR are dev-only", async () => {
  for (const production of [true, false]) {
    const headers = await configuredHeaders(production), csp = headers.get("Content-Security-Policy")!;
    assert.ok(csp.includes("script-src 'self' 'unsafe-inline'"));
    assert.ok(csp.includes("style-src 'self' 'unsafe-inline'"));
    assert.ok(csp.includes("media-src 'self' blob:"));
    assert.equal(csp.includes("unsafe-eval"), !production);
    assert.equal(csp.includes("ws: wss:"), !production);
    assert.equal(headers.has("Strict-Transport-Security"), production);
  }
});
