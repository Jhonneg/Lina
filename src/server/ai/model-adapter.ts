import "server-only";

export type ConversationMessage = {
  role: "user" | "assistant";
  content: string;
};

export interface ModelAdapter {
  generate(messages: readonly ConversationMessage[], signal: AbortSignal): Promise<string>;
}

export interface StreamingModelAdapter extends ModelAdapter {
  stream(messages: readonly ConversationMessage[], signal: AbortSignal): AsyncIterable<string>;
}

export class ModelError extends Error {
  constructor(readonly kind: "configuration" | "upstream" | "timeout") {
    super(`Model ${kind} error`);
    this.name = "ModelError";
  }
}
