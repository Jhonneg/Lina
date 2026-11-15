import { memoryUsage } from "../usage/fixtures";
import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { APPROVED_VOICE_PRESET } from "../../src/lib/cloud-voice/approved-preset";
import { chatVoiceEnabled, createChatVoiceHandler } from "../../src/server/cloud-voice/chat-handler";
const id = "11111111-1111-4111-8111-111111111111";
const request = (requestId = id, text = "A quiet thought.", cookie = "token", origin = "http://localhost") => new NextRequest("http://localhost/api/voice", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: `lain_session=${cookie}` }, body: JSON.stringify({ text, requestId }),
});
function fixture() {
  const calls: unknown[] = []; let session = true, broken = false, clock = 0;
  const handler = createChatVoiceHandler({ development: () => true, usage: memoryUsage(() => clock),
    service: { async getExistingSession(token) { if (broken) throw Error("PRIVATE_DB"); return token === "token" && session ? { id: "session", expiresAt: new Date(Date.now() + 10000) } : null; } },
    relay: async req => { calls.push(await req.json()); return new Response("mock", { headers: { "Content-Type": "text/event-stream" } }); },
  });
  return { handler, calls, expire: () => { session = false; }, fail: () => { broken = true; }, tick: (ms: number) => { clock += ms; } };
}

test("chat voice requires an existing valid session and same origin; disabled voice is blocked", async () => {
  const f = fixture(); assert.equal((await f.handler(request(id, "a", "unknown"))).status, 401);
  assert.equal((await f.handler(request(id, "a", "token", "https://evil.example"))).status, 403);
  f.expire(); assert.equal((await f.handler(request())).status, 401); assert.equal(f.calls.length, 0);
  const blocked = createChatVoiceHandler({ development: () => false }); assert.equal((await blocked(request())).status, 404);
  const failed = fixture(); failed.fail(); const response = await failed.handler(request()); assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("PRIVATE_DB"));
});

test("session-owned request IDs reserve one cloud attempt and force Shimmer with bounded input", async () => {
  const f = fixture(); const response = await f.handler(request()); await response.text();
  assert.deepEqual(f.calls, [{ text: "A quiet thought.", voice: "shimmer", delivery: APPROVED_VOICE_PRESET.delivery, confirmed: true }]);
  assert.equal((await f.handler(request())).status, 409); assert.equal((await f.handler(request(id, "Different"))).status, 409); assert.equal(f.calls.length, 1);
  assert.equal((await f.handler(request("invalid"))).status, 400); assert.equal((await f.handler(request(crypto.randomUUID(), "x".repeat(801)))).status, 400);
});

test("cloud requests enforce concurrency and conservative hourly/minute attempt budgets", async () => {
  const f = fixture(), first = await f.handler(request()); assert.equal((await f.handler(request(crypto.randomUUID()))).status, 429); await first.text();
  for (let i = 1; i < 3; i++) await (await f.handler(request(crypto.randomUUID()))).text();
  assert.equal((await f.handler(request(crypto.randomUUID()))).status, 429);
  for (let i = 3; i < 20; i++) { f.tick(60001); const response = await f.handler(request(crypto.randomUUID())); assert.equal(response.status, 200); await response.text(); }
  assert.equal((await f.handler(request(crypto.randomUUID()))).status, 429); assert.equal(f.calls.length, 20);
});

test("failed or uncertain upstream attempts cannot bill again under the same request ID", async () => {
  let calls = 0;
  const handler = createChatVoiceHandler({ development: () => true, usage: memoryUsage(),
    service: { async getExistingSession() { return { id: "session", expiresAt: new Date(Date.now() + 10000) }; } },
    relay: async () => { calls++; return Response.json({ error: { message: "Unavailable" } }, { status: 503 }); },
  });
  assert.equal((await handler(request())).status, 503); assert.equal((await handler(request())).status, 409); assert.equal(calls, 1);
});


test("main-chat callers cannot override approved delivery or effects", async () => {
  const f = fixture();
  const response = await f.handler(new NextRequest("http://localhost/api/voice", { method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json", Cookie: "lain_session=token" }, body: JSON.stringify({ requestId: id, text: "A thought.", delivery: "Override", effects: { pitch: 1 } }) }));
  assert.equal(response.status, 400); assert.equal(f.calls.length, 0);
});

const segmentRequest = (requestId: string, index: number, final: boolean, text: string) => new NextRequest("http://localhost/api/voice", {
  method: "POST", headers: { Origin: "http://localhost", "Content-Type": "application/json", Cookie: "lain_session=token" }, body: JSON.stringify({ requestId, text, segment: { index, final } }),
});
test("progressive requests share 800 characters and reject duplicates, skips and segments after final", async () => {
  const f = fixture();
  assert.equal((await f.handler(segmentRequest(id, 1, false, "Skipped."))).status, 409);
  await (await f.handler(segmentRequest(id, 0, false, "First."))).text();
  assert.equal((await f.handler(segmentRequest(id, 0, false, "First."))).status, 409);
  assert.equal((await f.handler(segmentRequest(id, 0, false, "Changed."))).status, 409);
  await (await f.handler(segmentRequest(id, 1, true, "Last."))).text();
  assert.equal((await f.handler(segmentRequest(id, 2, true, "Late."))).status, 409); assert.equal(f.calls.length, 2);
  const bounded = fixture(); await (await bounded.handler(segmentRequest(id, 0, false, "x".repeat(790)))).text();
  assert.equal((await bounded.handler(segmentRequest(id, 1, true, "y".repeat(10)))).status, 429); assert.equal(bounded.calls.length, 1);
});

test("each segment counts against existing usage limits; aggregate audio/time headroom is forwarded", async () => {
  let count = 0, firstDuration = 0;
  const handler = createChatVoiceHandler({ development: () => true, usage: memoryUsage(),
    service: { async getExistingSession() { return { id: "session", expiresAt: new Date(Date.now() + 10000) }; } },
    relay: async (_request, limits) => {
      count++;
      if (count === 1) { firstDuration = limits.durationMs!; assert.equal(limits.audioByteLimit, 2_880_000); limits.onAudio!(2_879_996); }
      else { assert.ok(limits.durationMs! < firstDuration); assert.equal(limits.audioByteLimit, 4); limits.onAudio!(4); }
      await limits.usageLease!.finish(undefined, { completed: true, generationMs: 1, audioBytes: count === 1 ? 2_879_996 : 4 }); return new Response("mock");
    },
  });
  await (await handler(segmentRequest(id, 0, false, "First."))).text(); await (await handler(segmentRequest(id, 1, false, "Second."))).text();
  assert.equal((await handler(segmentRequest(id, 2, true, "Third."))).status, 429); assert.equal(count, 2);
  const f = fixture();
  for (let i = 0; i < 3; i++) await (await f.handler(segmentRequest(id, i, i === 2, "A thought."))).text();
  assert.equal((await f.handler(request(crypto.randomUUID()))).status, 429); assert.equal(f.calls.length, 3);
});

test("cancelled progressive sequences release resources and cannot be resumed under the old ID", async () => {
  const f = fixture(), response = await f.handler(segmentRequest(id, 0, false, "First.")); await response.body!.cancel();
  assert.equal((await f.handler(segmentRequest(id, 1, true, "Late."))).status, 409);
  assert.equal((await f.handler(segmentRequest(crypto.randomUUID(), 3, true, "Invalid."))).status, 400);
});


test("explicit production voice opt-in retains session/accounting checks and never enables the lab", async () => {
  assert.equal(chatVoiceEnabled({ NODE_ENV: "production" }), false);
  assert.equal(chatVoiceEnabled({ NODE_ENV: "production", LAIN_VOICE_ENABLED: "true" }), true);
  assert.equal(chatVoiceEnabled({ NODE_ENV: "production", LAIN_VOICE_ENABLED: "false" }), false);
  assert.equal(chatVoiceEnabled({ NODE_ENV: "production", LAIN_VOICE_ENABLED: "typo" }), false);
  const names = ["NODE_ENV", "STAGING_ACCESS_MODE", "LAIN_VOICE_ENABLED"], old = names.map(name => process.env[name]);
  Object.assign(process.env, { NODE_ENV: "production", STAGING_ACCESS_MODE: "disabled", LAIN_VOICE_ENABLED: "true" });
  try {
    let calls = 0;
    const handler = createChatVoiceHandler({ usage: memoryUsage(),
      service: { async getExistingSession(token) { return token === "fixture" ? { id: "session", expiresAt: new Date(Date.now() + 10000) } : null; } },
      relay: async req => { const body = await req.json(); assert.equal(body.voice, APPROVED_VOICE_PRESET.voice); assert.equal(body.delivery, APPROVED_VOICE_PRESET.delivery); calls++; return new Response("mock PCM"); },
    });
    assert.equal((await handler(request())).status, 401); assert.equal(calls, 0);
    const authorized = request(); authorized.headers.set("Cookie", "__Host-lain_session=fixture");
    const response = await handler(authorized); assert.equal(response.status, 200); assert.equal(await response.text(), "mock PCM"); assert.equal(calls, 1);
    const { createCloudVoiceHandler } = await import("../../src/server/cloud-voice/handler");
    assert.equal((await createCloudVoiceHandler()(request())).status, 404);
    process.env.LAIN_VOICE_ENABLED = "false";
    assert.equal((await handler(authorized)).status, 404); assert.equal(calls, 1);
  } finally { names.forEach((name, i) => { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; }); }
});
