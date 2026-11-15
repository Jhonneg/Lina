import { createCloudVoiceHandler } from "../../../../server/cloud-voice/handler";

export const POST = createCloudVoiceHandler({ allowDelivery: true });
