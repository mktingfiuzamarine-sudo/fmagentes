export interface InboundMessageEvent {
  type: "messages.upsert";
  instanceName: string;
  messageId: string;
  fromMe: boolean;
  contactPhone: string;
  pushName: string | null;
  text: string | null;
  timestamp: number | null;
}

export interface ConnectionUpdateEvent {
  type: "connection.update";
  instanceName: string;
  state: string;
}

export interface QrCodeUpdatedEvent {
  type: "qrcode.updated";
  instanceName: string;
}

export type EvolutionWebhookEvent = InboundMessageEvent | ConnectionUpdateEvent | QrCodeUpdatedEvent;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const PHONE_JID = /^(\d+)@s\.whatsapp\.net$/;

function jidToPhone(jid: unknown): string | null {
  if (typeof jid !== "string") return null;
  return PHONE_JID.exec(jid)?.[1] ?? null;
}

/**
 * Only one-to-one chats get a contact phone. Groups (@g.us), status and
 * broadcast lists (@broadcast) and channels (@newsletter) resolve to null so
 * the bot never speaks there. A @lid sender is answerable only through the
 * phone JID Evolution may send alongside it (remoteJidAlt or senderPn).
 */
function contactPhoneOf(key: Record<string, unknown>): string | null {
  const direct = jidToPhone(key.remoteJid);
  if (direct) return direct;
  if (typeof key.remoteJid !== "string" || !key.remoteJid.endsWith("@lid")) return null;
  return jidToPhone(key.remoteJidAlt) ?? jidToPhone(key.senderPn);
}

function extractText(message: unknown): string | null {
  if (!isObject(message)) return null;
  if (typeof message.conversation === "string") return message.conversation;
  const ext = message.extendedTextMessage;
  if (isObject(ext) && typeof ext.text === "string") return ext.text;
  return null;
}

export function parseEvolutionEvent(body: unknown): EvolutionWebhookEvent | null {
  if (!isObject(body)) return null;
  const { event, instance, data } = body;
  if (typeof event !== "string" || typeof instance !== "string" || !isObject(data)) return null;

  if (event === "connection.update") {
    const state = isObject(data) && typeof data.state === "string" ? data.state : "unknown";
    return { type: "connection.update", instanceName: instance, state };
  }

  if (event === "qrcode.updated") {
    return { type: "qrcode.updated", instanceName: instance };
  }

  if (event === "messages.upsert") {
    const key = data.key;
    if (!isObject(key) || typeof key.id !== "string") return null;
    const phone = contactPhoneOf(key);
    if (!phone) return null;
    return {
      type: "messages.upsert",
      instanceName: instance,
      messageId: key.id,
      fromMe: key.fromMe === true,
      contactPhone: phone,
      pushName: typeof data.pushName === "string" ? data.pushName : null,
      text: extractText(data.message),
      timestamp: typeof data.messageTimestamp === "number" ? data.messageTimestamp : null,
    };
  }

  return null;
}
