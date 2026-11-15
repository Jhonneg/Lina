import { AsyncLocalStorage } from "node:async_hooks";
// The SDK owns this request-local store. Seed only synthetic platform context in tests.
export function withNetlifyIp<T>(ip: string, work: () => T): T {
  return withContext({ ip }, work);
}
export function withNetlifySite<T>(url: string, work: () => T): T {
  return withContext({ site: { url } }, work);
}
function withContext<T>(context: object, work: () => T): T {
  const store = (globalThis as Record<symbol, unknown>)[Symbol.for("@netlify/functions/request-context-store")] as AsyncLocalStorage<{ context: object }>;
  if (!(store instanceof AsyncLocalStorage)) throw new Error("Netlify SDK context store not initialized.");
  return store.run({ context }, work);
}
