import "server-only";
import OpenAI from "openai";
import { ModelError, type StreamingModelAdapter } from "./model-adapter";
import { LAIN_PERSONALITY_INSTRUCTIONS } from "./personality";

export const MODEL_TIMEOUT_MS = 20_000;
export const MAX_OUTPUT_TOKENS = 768;

export function createOpenAIAdapter(config: { apiKey: string; model: string }, fetchImpl?: typeof fetch): StreamingModelAdapter {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: "https://api.openai.com/v1",
    timeout: MODEL_TIMEOUT_MS,
    maxRetries: 0,
    logLevel: "off",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });

  return {
    billing: { model: config.model },
    async *stream(messages, signal, onUsage) {
      let upstream;
      try {
        signal.throwIfAborted();
        upstream = await client.responses.create({
          model: config.model,
          instructions: LAIN_PERSONALITY_INSTRUCTIONS,
          input: messages.map(({ role, content }) => ({ role, content })),
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
          stream: true,
        }, { signal });
        for await (const event of upstream) {
          signal.throwIfAborted();
          if (event.type === "response.output_text.delta") yield event.delta;
          else if (event.type === "response.completed") {
            if (event.response.status !== "completed") throw new ModelError("upstream");
            if (event.response.usage) onUsage?.({ input: event.response.usage.input_tokens, cached: event.response.usage.input_tokens_details?.cached_tokens ?? 0, output: event.response.usage.output_tokens, audio: 0 });
            return;
          } else if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
            throw new ModelError("upstream");
          }
        }
        // EOF alone does not prove that the provider completed successfully.
        throw new ModelError("upstream");
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof OpenAI.APIConnectionTimeoutError) throw new ModelError("timeout");
        throw new ModelError("upstream");
      } finally {
        upstream?.controller.abort();
      }
    },
    async generate(messages, signal, onUsage) {
      try {
        const response = await client.responses.create({
          model: config.model,
          instructions: LAIN_PERSONALITY_INSTRUCTIONS,
          input: messages.map(({ role, content }) => ({ role, content })),
          max_output_tokens: MAX_OUTPUT_TOKENS,
          store: false,
          stream: false,
        }, { signal });
        const text = response.output_text?.trim();
        if (response.status !== "completed" || !text) throw new ModelError("upstream");
        if (response.usage) onUsage?.({ input: response.usage.input_tokens, cached: response.usage.input_tokens_details?.cached_tokens ?? 0, output: response.usage.output_tokens, audio: 0 });
        return text;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (error instanceof OpenAI.APIConnectionTimeoutError) throw new ModelError("timeout");
        throw new ModelError("upstream");
      }
    },
  };
}
