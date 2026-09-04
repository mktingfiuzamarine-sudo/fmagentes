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

function jidToPhone(jid: unknown): string | null {
  if (typeof jid !== "string" || !jid.includes("@")) return null;
  return jid.split("@")[0];
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
    const phone = jidToPhone(key.remoteJid);
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
