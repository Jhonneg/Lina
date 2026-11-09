import "server-only";
import OpenAI from "openai";
import { ModelError, type ModelAdapter } from "./model-adapter";

export const MODEL_TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_TOKENS = 768;

export function createOpenAIAdapter(config: { apiKey: string; model: string }, fetchImpl?: typeof fetch): ModelAdapter {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: "https://api.openai.com/v1",
    timeout: MODEL_TIMEOUT_MS,
    maxRetries: 0,
    logLevel: "off",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  return {
    async generate(messages, signal) {
      try {
        const response = await client.responses.create({
          model: config.model,
          input: messages.map(({ role, content }) => ({ role, content })),
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
          stream: false,
        }, { signal });
        const text = response.output_text?.trim();
        if (response.status !== "completed" || !text) throw new ModelError("upstream");
        return text;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof OpenAI.APIConnectionTimeoutError) throw new ModelError("timeout");
        throw new ModelError("upstream");
      }
    },
  };
}
