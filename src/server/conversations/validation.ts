import "server-only";

export const STORAGE_LIMITS = { titleChars: 200, messageChars: 16000, pageSize: 50, offset: 10000, bodyBytes: 2048 } as const;
export class StorageInputError extends Error {
  constructor(message = "Invalid conversation input.", readonly status = 400, readonly code = "INVALID_INPUT") { super(message); }
}
export function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new StorageInputError("Use a valid UUID.");
  return value.toLowerCase();
}
export function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new StorageInputError();
  return value as Record<string, unknown>;
}
export function titleInput(value: unknown): string | null {
  const { title } = object(value, ["title"]);
  if (title === undefined || title === null) return null;
  if (typeof title !== "string" || !title.trim() || title.length > STORAGE_LIMITS.titleChars) throw new StorageInputError("Title must be non-empty text of at most 200 characters, or null.");
  return title.trim();
}
export type Page = { limit: number; offset: number };
export function pageInput(value: Page): Page {
  if (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > STORAGE_LIMITS.pageSize ||
      !Number.isInteger(value.offset) || value.offset < 0 || value.offset > STORAGE_LIMITS.offset) throw new StorageInputError("Pagination is out of bounds.");
  return { limit: value.limit, offset: value.offset };
}
export function queryPage(params: URLSearchParams): Page {
  for (const key of params.keys()) if (!["limit", "offset"].includes(key) || params.getAll(key).length !== 1) throw new StorageInputError("Unsupported pagination parameters.");
  const limit = params.get("limit") ?? "20", offset = params.get("offset") ?? "0";
  if (!/^\d{1,5}$/.test(limit) || !/^\d{1,5}$/.test(offset)) throw new StorageInputError("Pagination must use whole numbers.");
  return pageInput({ limit: Number(limit), offset: Number(offset) });
}
export type MessageStatus = "completed" | "interrupted" | "failed";
function contentInput(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > STORAGE_LIMITS.messageChars) throw new StorageInputError("Message content must be non-empty text of at most 16000 characters.");
  return value; // Preserve whitespace in assistant text and future streamed updates.
}
function statusInput(value: unknown): MessageStatus {
  if (value !== "completed" && value !== "interrupted" && value !== "failed") throw new StorageInputError("Invalid message status.");
  return value;
}
export function messageInput(value: unknown) {
  const item = object(value, ["role", "content", "status"]);
  if (item.role !== "user" && item.role !== "assistant") throw new StorageInputError("Invalid message role.");
  return { role: item.role, content: contentInput(item.content), status: item.status === undefined ? "completed" as const : statusInput(item.status) };
}
export function messagePatch(value: unknown) {
  const item = object(value, ["content", "status"]);
  if (item.content === undefined && item.status === undefined) throw new StorageInputError("Provide message content or status.");
  return { ...(item.content !== undefined ? { content: contentInput(item.content) } : {}),
    ...(item.status !== undefined ? { status: statusInput(item.status) } : {}) };
}
