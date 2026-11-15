import "server-only";
import { getContext } from "@netlify/functions";
import { createHmac } from "node:crypto";
import { isIP } from "node:net";
import { RequestError } from "../chat-request";

export class UsageError extends RequestError {
  constructor(status = 429, code = "USAGE_LIMIT", message = "Usage limit reached. Please try again later.", readonly retryAfter = 60) { super(status, code, message); }
}
export const unavailable = () => new UsageError(503, "USAGE_UNAVAILABLE", "Usage accounting is temporarily unavailable. Please try again later.", 30);
export type TokenUsage = { input: number; cached: number; output: number; audio: number };
export type Pricing = { input: number; cached: number; output: number; audio: number };
export type UsagePolicy = ReturnType<typeof usagePolicy>;
type Env = Record<string, string | undefined>;
export function usagePolicy(env: Env = process.env) {
  function number(name: string, fallback: number, max = 100000) {
    const value = env[name]?.trim() ? Number(env[name]) : fallback;
    if (!Number.isFinite(value) || value < 0 || value > max) throw unavailable(); return value;
  }
  function count(name: string, fallback: number) { const value = number(name, fallback); if (!Number.isInteger(value)) throw unavailable(); return value; }
  const { proxy, ipKey } = trustedIpPolicy(env);
  const sessionConcurrent = count("USAGE_SESSION_CONCURRENCY", 2), globalConcurrent = count("USAGE_GLOBAL_CONCURRENCY", 4);
  if (sessionConcurrent < 1 || globalConcurrent < 1) throw unavailable();
  return {
    textHour: count("USAGE_TEXT_HOURLY_LIMIT", 20), textDay: count("USAGE_TEXT_DAILY_LIMIT", 100),
    speechHour: count("USAGE_SPEECH_HOURLY_LIMIT", 20), speechDay: count("USAGE_SPEECH_DAILY_LIMIT", 60), speechMinute: count("USAGE_SPEECH_MINUTE_LIMIT", 3),
    sessionConcurrent, globalConcurrent,
    ipMinute: count("USAGE_IP_MINUTE_LIMIT", 20), ipHour: count("USAGE_IP_HOURLY_LIMIT", 100),
    budgetMicro: Math.floor(number("USAGE_DAILY_BUDGET_USD", 1, 10000) * 1_000_000),
    proxy, ipKey,
    textPricing: env.USAGE_TEXT_INPUT_USD_PER_MILLION?.trim() && env.USAGE_TEXT_OUTPUT_USD_PER_MILLION?.trim() ? {
      input: number("USAGE_TEXT_INPUT_USD_PER_MILLION", 0, 10000), cached: number("USAGE_TEXT_CACHED_USD_PER_MILLION", Number(env.USAGE_TEXT_INPUT_USD_PER_MILLION), 10000),
      output: number("USAGE_TEXT_OUTPUT_USD_PER_MILLION", 0, 10000), audio: 0,
    } : null,
  };
}
export function trustedIpPolicy(env: Env = process.env) {
  const proxy = env.USAGE_TRUSTED_PROXY ?? "none";
  if (!["none", "vercel", "netlify"].includes(proxy) || (env.NODE_ENV === "production" && proxy === "none") || (proxy === "vercel" && (env.VERCEL !== "1" || !env.USAGE_IP_HMAC_KEY || env.USAGE_IP_HMAC_KEY.length < 32))) throw unavailable();
  if (proxy === "netlify" && (!env.USAGE_IP_HMAC_KEY || env.USAGE_IP_HMAC_KEY.length < 32)) throw unavailable();
  return { proxy, ipKey: env.USAGE_IP_HMAC_KEY };
}
export function ipDigest(request: Request, policy: ReturnType<typeof trustedIpPolicy>, date: Date) {
  if (policy.proxy === "none") return null; // Ignore all spoofable forwarded headers in local development.
  let ip: string | undefined;
  try {
    // Platform request context, never a caller-controlled forwarded header.
    ip = policy.proxy === "netlify" ? getContext().ip : request.headers.get("x-vercel-forwarded-for")?.trim();
  } catch { throw unavailable(); }
  if (!ip || !isIP(ip) || ip.includes(",")) throw unavailable();
  let normalized = isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname.toLowerCase() : ip;
  // Treat IPv4-mapped IPv6 as the same address; retain only a daily keyed digest.
  if (/^\[::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}\]$/.test(normalized)) {
    const words = normalized.slice(8, -1).split(":").map(value => parseInt(value, 16));
    normalized = `${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`;
  }
  return createHmac("sha256", policy.ipKey!).update(`${date.toISOString().slice(0, 10)}:${normalized}`).digest("hex");
}
export function costMicro(usage: TokenUsage, price: Pricing) {
  if (!Object.values(usage).every(value => Number.isSafeInteger(value) && value >= 0) || usage.cached > usage.input) throw unavailable();
  const value = Math.ceil((usage.input - usage.cached) * price.input + usage.cached * price.cached + usage.output * price.output + usage.audio * price.audio);
  if (!Number.isSafeInteger(value) || value < 0) throw unavailable(); return value;
}
export function reserveEstimate(kind: "text" | "speech", source: string, policy: UsagePolicy) {
  const pricing = kind === "text" ? policy.textPricing : { input: .60, cached: .06, output: 2.40, audio: 20 };
  if (!pricing || (kind === "text" && (pricing.input <= 0 || pricing.output <= 0 || pricing.cached > pricing.input))) throw new UsageError(503, "USAGE_PRICING_REQUIRED", "Configure server-side model pricing before enabling paid text generation.", 30);
  const input = new TextEncoder().encode(source).byteLength + 2048;
  return { pricing, micro: costMicro({ input, cached: 0, output: kind === "text" ? 768 : 0, audio: kind === "speech" ? 2048 : 0 }, pricing) };
}
