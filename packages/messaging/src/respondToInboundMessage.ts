import type { MessagingDeps } from "./deps";
import type { InboundJobData } from "./inboundQueue";
import type { CustomerContext, HistoryMessage, ResponderPort } from "./responder";
import type { CustomerDirectoryPort } from "./customerDirectory";
import { ConversationBusyError, LockLostError, type ConversationLock, type LockHandle } from "./conversationLock";
import { DEFAULT_HISTORY_LIMIT } from "./conversationHistory";
import { laterTimestamp } from "./internal/timestamps";
import { createSupabaseRespondStore, type InboundContext, type RespondStore } from "./respondStore";
import { sendMessage, ConversationNotFoundError } from "./sendMessage";

export type RespondDeps = MessagingDeps & {
  responder: ResponderPort;
  conversationLock: ConversationLock;
  customerDirectory: CustomerDirectoryPort;
  /** Defaults to the Supabase-backed store; tests inject a fake. */
  store?: RespondStore;
  /** How many recent messages the responder sees. Defaults to DEFAULT_HISTORY_LIMIT. */
  historyLimit?: number;
};

export type RespondResult =
  | { status: "sent"; messageId: string }
  | { status: "handoff"; messageId: string }
  | {
      status: "skipped";
      reason: "no-active-agent" | "already-answered" | "responder-declined" | "message-not-found" | "awaiting-human";
    };

const MESSAGE_NOT_FOUND: RespondResult = { status: "skipped", reason: "message-not-found" };

export async function respondToInboundMessage(deps: RespondDeps, job: InboundJobData): Promise<RespondResult> {
  const lock = await deps.conversationLock.acquire(job.conversationId);
  if (!lock) throw new ConversationBusyError(job.conversationId);

  const store = deps.store ?? createSupabaseRespondStore(deps.supabase);

  try {
    const inbound = await store.loadInbound(job.messageId);
    if (!inbound) return MESSAGE_NOT_FOUND;

    if (inbound.conversationStatus === "awaiting_human") {
      if (!isOwedHandoffNotice(inbound)) return { status: "skipped", reason: "awaiting-human" };
      return await sendPendingHandoffNotice(deps, store, lock, inbound);
    }

    const agent = await store.resolveAgent(inbound);
    if (!agent) return { status: "skipped", reason: "no-active-agent" };

    // Retry and burst safety: answered only if some reply was generated from
    // a history that already held this message. Database clock throughout.
    if (await store.isAnswered(inbound.conversationId, inbound.receivedAt)) {
      return { status: "skipped", reason: "already-answered" };
    }

    const { messages: history, seenThrough } = await store.loadHistory(
      inbound.conversationId,
      deps.historyLimit ?? DEFAULT_HISTORY_LIMIT,
    );
    // The reply answers this message even if it fell out of the window.
    const watermark = laterTimestamp(seenThrough, inbound.receivedAt);
    const customer = await identifyCustomer(deps.customerDirectory, store, inbound);
    const incoming: HistoryMessage = { role: "user", content: inbound.content, createdAt: inbound.createdAt };

    const result = await deps.responder.generate({
      agent,
      history,
      incoming,
      conversationId: inbound.conversationId,
      contactPhone: inbound.contactPhone,
      customer,
    });

    if (result.linkedCustomer) {
      await store.linkCustomer(inbound.conversationId, result.linkedCustomer.crmClientId, result.linkedCustomer.via);
    }

    switch (result.kind) {
      case "decline":
        return { status: "skipped", reason: "responder-declined" };
      case "reply": {
        const messageId = await sendGuarded(deps, lock, inbound.conversationId, result.text, watermark);
        return messageId ? { status: "sent", messageId } : MESSAGE_NOT_FOUND;
      }
      case "handoff": {
        // Persist first: if the send fails, the retry finds a pending handoff
        // and only sends the notice — the model is not called again.
        if (lock.isLost()) throw new LockLostError(inbound.conversationId);
        await store.markAwaitingHuman(inbound.conversationId, {
          summary: result.summary,
          handoffAt: inbound.receivedAt,
        });
        const messageId = await sendGuarded(deps, lock, inbound.conversationId, agent.handoffMessage, watermark);
        return messageId ? { status: "handoff", messageId } : MESSAGE_NOT_FOUND;
      }
    }
  } finally {
    await lock.release();
  }
}

/**
 * handoff_at is the received_at of the message that triggered the handoff, so
 * that message (and anything received before it) is still owed the notice;
 * anything received later belongs to the human.
 */
function isOwedHandoffNotice(inbound: InboundContext): boolean {
  return inbound.handoffAt !== null && Date.parse(inbound.receivedAt) <= Date.parse(inbound.handoffAt);
}

async function sendPendingHandoffNotice(
  deps: RespondDeps,
  store: RespondStore,
  lock: LockHandle,
  inbound: InboundContext,
): Promise<RespondResult> {
  const agent = await store.resolveAgent(inbound);
  if (!agent) return { status: "skipped", reason: "no-active-agent" };

  if (await store.isAnswered(inbound.conversationId, inbound.receivedAt)) {
    return { status: "skipped", reason: "already-answered" };
  }

  // One notice covers everything up to the trigger: stamp it with handoff_at so
  // the trigger's own retry (or an earlier burst message's job) sees it as answered.
  const answersThrough = inbound.handoffAt ?? inbound.receivedAt;
  const messageId = await sendGuarded(deps, lock, inbound.conversationId, agent.handoffMessage, answersThrough);
  return messageId ? { status: "handoff", messageId } : MESSAGE_NOT_FOUND;
}

async function identifyCustomer(
  directory: CustomerDirectoryPort,
  store: RespondStore,
  inbound: InboundContext,
): Promise<CustomerContext> {
  if (inbound.crmClientId) {
    // Anyone can type someone else's CPF: a CPF link never exposes stored data.
    if (inbound.crmLinkVia === "cpf") return { status: "registered" };
    const known = await directory.findById(inbound.crmClientId);
    return known ? { status: "registered", name: known.name } : { status: "unregistered" };
  }

  const match = await directory.findByPhone(inbound.contactPhone);
  if (!match) return { status: "unregistered" };

  await store.linkCustomer(inbound.conversationId, match.id, "phone");
  return { status: "registered", name: match.name };
}

/** Sends unless the lock was lost; null when the conversation vanished. */
async function sendGuarded(
  deps: MessagingDeps,
  lock: LockHandle,
  conversationId: string,
  text: string,
  answersThrough: string,
): Promise<string | null> {
  if (lock.isLost()) throw new LockLostError(conversationId);
  try {
    const sent = await sendMessage(deps, { conversationId, text, answersThrough });
    return sent.id;
  } catch (error) {
    // The conversation vanished mid-flight; retrying cannot fix that.
    if (error instanceof ConversationNotFoundError) return null;
    throw error;
  }
}
