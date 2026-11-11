import { createConversationHandlers } from "../../../server/conversations/handler";

const handlers = createConversationHandlers();
export const GET = handlers.list;
export const POST = handlers.create;
