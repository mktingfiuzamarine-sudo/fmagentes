export type { MessagingDeps } from "./deps";
export { INBOUND_QUEUE_NAME, createInboundQueue, type InboundJobData } from "./inboundQueue";
export {
  parseEvolutionEvent,
  type EvolutionWebhookEvent,
  type InboundMessageEvent,
  type ConnectionUpdateEvent,
  type QrCodeUpdatedEvent,
} from "./events";
export { ingestInboundMessage, type IngestResult } from "./ingestInboundMessage";
export { sendMessage, ConversationNotFoundError, type SentMessage } from "./sendMessage";
