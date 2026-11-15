import assert from "node:assert/strict";
import { test } from "node:test";
import { ipDigest, trustedIpPolicy, UsageError } from "../../src/server/usage/policy";
import { withNetlifyIp } from "./context";

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
