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
export {
  EchoResponder,
  type AgentConfig,
  type HistoryMessage,
  type ResponderInput,
  type ResponderPort,
} from "./responder";
export {
  ConversationBusyError,
  noopLock,
  type ConversationLock,
  type LockHandle,
} from "./conversationLock";
export { loadConversationHistory, DEFAULT_HISTORY_LIMIT } from "./conversationHistory";
