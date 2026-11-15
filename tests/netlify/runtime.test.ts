import assert from "node:assert/strict";
import { test } from "node:test";
import { ipDigest, trustedIpPolicy, UsageError } from "../../src/server/usage/policy";
import { withNetlifyIp, withNetlifySite } from "./context";
import { hasSameOrigin } from "../../src/server/request-origin";
import { createSessionHandler } from "../../src/server/session-handler";
import { NextRequest } from "next/server";

const day = new Date("2026-11-15"), policy = trustedIpPolicy({ NODE_ENV: "production", USAGE_TRUSTED_PROXY: "netlify", USAGE_IP_HMAC_KEY: "fixture-only-secret-with-at-least-32-characters" });
const request = new Request("https://lain.example/api/session", { headers: {
  "x-forwarded-for": "192.0.2.1", "x-vercel-forwarded-for": "192.0.2.2", "x-nf-client-connection-ip": "192.0.2.3" } });
test("Netlify fails closed without platform context regardless of spoofed headers or env markers", () => {
  assert.throws(() => ipDigest(request, policy, day), UsageError);
  assert.throws(() => trustedIpPolicy({ NODE_ENV: "production", USAGE_TRUSTED_PROXY: "netlify", NETLIFY: "true" }), UsageError);
  assert.throws(() => withNetlifyIp("203.0.113.1, 203.0.113.2", () => ipDigest(request, policy, day)), UsageError);
  assert.throws(() => withNetlifyIp("", () => ipDigest(request, policy, day)), UsageError);
});
test("SDK async context supplies isolated, canonical, daily-keyed IPs; forwarded values have no effect", async () => {
  const values = await Promise.all(["203.0.113.8", "::ffff:203.0.113.8", "203.0.113.9"].map(ip =>
    withNetlifyIp(ip, async () => { await Promise.resolve(); return ipDigest(request, policy, day); })));
  assert.match(values[0]!, /^[a-f0-9]{64}$/); assert.equal(values[0], values[1]); assert.notEqual(values[0], values[2]);
  withNetlifyIp("203.0.113.8", () => {
    assert.equal(ipDigest(new Request("https://lain.example"), policy, day), values[0]);
    assert.notEqual(ipDigest(request, policy, new Date("2026-11-16")), values[0]);
  });
});

const netlify = { USAGE_TRUSTED_PROXY: "netlify" }, publicOrigin = "https://lain.example";
function originRequest(url = "http://localhost:3000/api/session", origin: string | null = publicOrigin, extra: Record<string, string> = {}) {
  return new NextRequest(url, { method: "POST", headers: { ...(origin === null ? {} : { Origin: origin }), "Sec-Fetch-Site": "same-origin", ...extra } });
}
test("Netlify CSRF uses the platform's public site URL even when OpenNext reconstructs an internal URL", () => {
  withNetlifySite(publicOrigin, () => {
    for (const internal of ["http://localhost:3000/api/session", "http://internal:443/api/session", `${publicOrigin}/api/session`]) {
      assert.equal(hasSameOrigin(originRequest(internal), false, netlify), true);
    }
  });
});
test("Netlify HTTP site metadata is normalized to the public HTTPS origin", () => {
  withNetlifySite("http://lain.example", () => {
    assert.equal(hasSameOrigin(originRequest("http://localhost:3000/api/session"), false, netlify), true);
  });
});
test("public-origin validation rejects forged origins, forwarded hosts, missing origins and cross-site requests", () => {
  withNetlifySite(publicOrigin, () => {
    assert.equal(hasSameOrigin(originRequest("https://attacker.example/api/session", "https://attacker.example", { "x-forwarded-host": "lain.example", "x-forwarded-proto": "https" }), false, netlify), false);
    assert.equal(hasSameOrigin(originRequest(undefined, null), false, netlify), false);
    assert.equal(hasSameOrigin(originRequest(undefined, null), true, netlify), true);
    assert.equal(hasSameOrigin(originRequest(undefined, publicOrigin, { "Sec-Fetch-Site": "cross-site" }), false, netlify), false);
    assert.equal(hasSameOrigin(originRequest(undefined, "https://lain.example.attacker.example"), false, netlify), false);
  });
});
test("Netlify origin validation fails closed without valid platform site metadata", () => {
  assert.equal(hasSameOrigin(originRequest(), false, netlify), false);
  for (const invalid of ["", "not a URL", "ftp://lain.example", "https://user:password@lain.example"]) {
    withNetlifySite(invalid, () => assert.equal(hasSameOrigin(originRequest(), false, netlify), false));
  }
  withNetlifyIp("203.0.113.8", () => assert.equal(hasSameOrigin(originRequest(), false, netlify), false));
});
test("local origin checks retain strict matching without requiring Netlify context", () => {
  assert.equal(hasSameOrigin(originRequest("http://localhost:3000/api/session", "http://localhost:3000"), false, {}), true);
  assert.equal(hasSameOrigin(originRequest(), false, {}), false);
});
test("platform origins remain isolated across asynchronous requests", async () => {
  const checks = await Promise.all([publicOrigin, "https://other.example"].map(url => withNetlifySite(url, async () => {
    await Promise.resolve(); return hasSameOrigin(originRequest(), false, netlify);
  })));
  assert.deepEqual(checks, [true, false]);
});
test("session handler admits the public browser origin behind OpenNext and rejects attackers before database work", async () => {
  const previous = process.env.USAGE_TRUSTED_PROXY;
  process.env.USAGE_TRUSTED_PROXY = "netlify";
  let sessions = 0, admissions = 0;
  const handler = createSessionHandler({ production: true,
    service: { async getOrCreateSession() { sessions++; return { session: { id: "9efbc372-d4ad-4a2d-8fc5-023314c9871f", expiresAt: new Date("2027-01-01") }, newToken: "a".repeat(64) }; } },
    abuse: { async take() { admissions++; } },
  });
  try {
    await withNetlifySite(publicOrigin, async () => {
      assert.equal((await handler(originRequest())).status, 200);
      assert.equal((await handler(originRequest("https://attacker.example/api/session", "https://attacker.example"))).status, 403);
    });
    assert.equal(sessions, 1); assert.equal(admissions, 2);
  } finally {
    if (previous === undefined) delete process.env.USAGE_TRUSTED_PROXY; else process.env.USAGE_TRUSTED_PROXY = previous;
  }
});
