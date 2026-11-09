import "server-only";
import { ModelError, type StreamingModelAdapter } from "./model-adapter";
import { createMockAdapter } from "./mock-adapter";
import { createOpenAIAdapter } from "./openai-adapter";

type Environment = Partial<Record<"NODE_ENV" | "LAIN_AI_MODE" | "OPENAI_API_KEY" | "OPENAI_MODEL", string>>;

export function createModelAdapter(env: Environment = process.env): StreamingModelAdapter {
  const mode = env.LAIN_AI_MODE?.trim();
  if (mode === "mock") return createMockAdapter(env.NODE_ENV);
  const apiKey = env.OPENAI_API_KEY?.trim();
  const model = env.OPENAI_MODEL?.trim();
  if (mode !== "openai" || !apiKey || !model) throw new ModelError("configuration");
  return createOpenAIAdapter({ apiKey, model });
}
