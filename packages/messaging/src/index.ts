export type { MessagingDeps } from "./deps";
export { INBOUND_QUEUE_NAME, INBOUND_JOB_OPTIONS, createInboundQueue, type InboundJobData } from "./inboundQueue";
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
  ResponderConfigurationError,
  type AgentConfig,
  type CustomerContext,
  type HistoryMessage,
  type LinkedCustomer,
  type ResponderInput,
  type ResponderPort,
  type ResponderResult,
} from "./responder";
export type { CustomerDirectoryPort, DirectoryCustomer } from "./customerDirectory";
export {
  createSupabaseRespondStore,
  type ConversationStatus,
  type CrmLinkVia,
  type InboundContext,
  type RespondStore,
} from "./respondStore";
export {
  ConversationBusyError,
  LockLostError,
  noopLock,
  type ConversationLock,
  type LockHandle,
} from "./conversationLock";
export { loadConversationHistory, DEFAULT_HISTORY_LIMIT } from "./conversationHistory";
export { resolveAgentForConversation } from "./resolveAgent";
export {
  respondToInboundMessage,
  type RespondDeps,
  type RespondResult,
} from "./respondToInboundMessage";
