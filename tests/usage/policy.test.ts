import assert from "node:assert/strict";
import { test } from "node:test";
import { usagePolicy, ipDigest, reserveEstimate, costMicro, UsageError } from "../../src/server/usage/policy";
import { createUsageService } from "../../src/server/usage/service";
import { createChatHandler } from "../../src/server/chat-handler";
import { createCloudVoiceHandler } from "../../src/server/cloud-voice/handler";
import { streamCloudVoice, CloudVoiceRequestError } from "../../src/lib/cloud-voice/stream";
import { mockLease } from "./fixtures";

const env = { NODE_ENV: "test", USAGE_TEXT_INPUT_USD_PER_MILLION: "1", USAGE_TEXT_OUTPUT_USD_PER_MILLION: "2" };
test("pricing uses conservative byte-based reservations and exact integer-micro reconciliation", () => {
  const policy = usagePolicy(env), reservation = reserveEstimate("text", "A short input", policy);
  assert.equal(reservation.micro, (2048 + 13) + 768 * 2);
  assert.equal(costMicro({ input: 100, cached: 20, output: 30, audio: 0 }, { input: 1, cached: .1, output: 2, audio: 20 }), 142);
  assert.throws(() => reserveEstimate("text", "x", usagePolicy({ NODE_ENV: "test" })), UsageError);
  assert.throws(() => costMicro({ input: 1, cached: 2, output: 0, audio: 0 }, { input: 1, cached: 1, output: 1, audio: 0 }));
  assert.throws(() => usagePolicy({ USAGE_GLOBAL_CONCURRENCY: "nonsense" }));
  assert.throws(() => reserveEstimate("text", "x", usagePolicy({ ...env, USAGE_TEXT_CACHED_USD_PER_MILLION: "2" })), UsageError);
});
test("forwarded IP is ignored unless a verified deployment mode and HMAC key are configured", () => {
  const request = new Request("http://localhost", { headers: { "x-forwarded-for": "1.2.3.4", "x-vercel-forwarded-for": "203.0.113.8" } });
  assert.equal(ipDigest(request, usagePolicy({ NODE_ENV: "test" }), new Date()), null);
  assert.throws(() => usagePolicy({ NODE_ENV: "production" }));
  assert.throws(() => usagePolicy({ USAGE_TRUSTED_PROXY: "vercel", USAGE_IP_HMAC_KEY: "x".repeat(40) }));
  const policy = usagePolicy({ ...env, USAGE_TRUSTED_PROXY: "vercel", VERCEL: "1", USAGE_IP_HMAC_KEY: "x".repeat(40) });
  const first = ipDigest(request, policy, new Date("2026-11-15T10:00:00Z"));
  assert.match(first!, /^[a-f0-9]{64}$/); assert.notEqual(first, ipDigest(request, policy, new Date("2026-11-16T10:00:00Z")));
  assert.throws(() => ipDigest(new Request("http://localhost", { headers: { "x-forwarded-for": "1.2.3.4" } }), policy, new Date()));
  const a = new Request("http://localhost", { headers: { "x-vercel-forwarded-for": "::ffff:203.0.113.8" } });
  assert.equal(ipDigest(a, policy, new Date("2026-11-15")), first);
});
test("database failures are safe and never reach the mock provider", async () => {
  const usage = createUsageService(() => { throw Error("PRIVATE_DATABASE_URL"); }, () => usagePolicy(env));
  await assert.rejects(usage.reserve({ request: new Request("http://localhost"), sessionId: crypto.randomUUID(), requestId: crypto.randomUUID(), kind: "text", model: "fixture", source: "input" }), error => error instanceof UsageError && error.code === "USAGE_UNAVAILABLE" && !error.message.includes("PRIVATE"));
  let calls = 0;
  const handler = createChatHandler({ getAdapter: () => ({ billing: { model: "fixture" }, async generate() { calls++; return "unused"; } }), usage });
  const response = await handler(new Request("http://localhost/api/chat", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ messages: [{ role: "user", content: "Hello" }] }) }));
  assert.equal(response.status, 401); assert.equal(calls, 0);
});
test("failed reconciliation cannot emit a successful cloud completion, and UI receives a concise safe limit", async () => {
  const lease = mockLease(); lease.finish = async () => { throw new UsageError(503, "USAGE_UNAVAILABLE", "Usage accounting is temporarily unavailable.", 30); };
  const handler = createCloudVoiceHandler({ development: () => true, key: () => "fake", usageLease: lease,
    connect: async () => { throw Error("NO_NETWORK"); } });
  const response = await handler(new Request("http://localhost", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json" }, body: JSON.stringify({ text: "Hi", voice: "shimmer", confirmed: true }) }));
  const wire = await response.text(); assert.ok(wire.includes("USAGE_UNAVAILABLE") && !wire.includes("event: done") && !wire.includes("NO_NETWORK"));
  const fetcher: typeof fetch = async () => Response.json({ error: { code: "USAGE_DAILY", message: "Daily usage limit reached. Please try again tomorrow." } }, { status: 429, headers: { "Retry-After": "60" } });
  await assert.rejects(streamCloudVoice("Hello", "shimmer", new AbortController().signal, () => {}, fetcher, crypto.randomUUID()), error => error instanceof CloudVoiceRequestError && error.message.includes("Daily usage limit"));
});
