import { createConversationHandlers } from "../../../../server/conversations/handler";

const handlers = createConversationHandlers();
export const GET = handlers.get;
export const PATCH = handlers.rename;
export const DELETE = handlers.remove;
