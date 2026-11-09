import "server-only";
import { ModelError, type ModelAdapter } from "./model-adapter";

export const MOCK_RESPONSE = "This is Lain’s deterministic development mock response. No OpenAI request was made.";

export function createMockAdapter(nodeEnv: string | undefined): ModelAdapter {
  if (nodeEnv !== "development") throw new ModelError("configuration");
  return {
    async generate(_messages, signal) {
      signal.throwIfAborted();
      return MOCK_RESPONSE;
    },
  };
}
