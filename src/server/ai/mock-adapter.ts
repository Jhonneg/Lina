import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { ModelError, type StreamingModelAdapter } from "./model-adapter";

export const MOCK_RESPONSE = "This is Lain’s deterministic development mock response. No OpenAI request was made.";

export function createMockAdapter(nodeEnv: string | undefined): StreamingModelAdapter {
  if (nodeEnv !== "development") throw new ModelError("configuration");
  return {
    async generate(_messages, signal) {
      signal.throwIfAborted();
      return MOCK_RESPONSE;
    },
    async *stream(_messages, signal) {
      for (const chunk of MOCK_RESPONSE.match(/.{1,16}/gu) ?? []) {
        await delay(80, undefined, { signal });
        yield chunk;
      }
    },
  };
}
