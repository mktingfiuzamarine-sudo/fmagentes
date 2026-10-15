import type { FastifyBaseLogger } from "fastify";
import type { CustomerNamePort } from "./customerNames";
import type { InboxRow, MessageRow } from "./store";

export const PREVIEW_LENGTH = 140;

export type Person = { id: string; displayName: string };
export type CustomerView =
  | { linkVia: null }
  | { linkVia: "phone" | "created"; name: string | null }
  | { linkVia: "cpf"; unverified: true };

function person(id: string | null, names: Map<string, string>): Person | null {
  return id ? { id, displayName: names.get(id) ?? id } : null;
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

export function toListItem(row: InboxRow, names: Map<string, string>) {
  return {
    id: row.id,
    contactPhone: row.contactPhone,
    instance: row.instance,
    status: row.status,
    handoffSummary: row.handoffSummary,
    handoffAt: row.handoffAt,
    assignedTo: person(row.assignedTo, names),
    lastMessage: row.lastMessage
      ? { ...row.lastMessage, content: truncate(row.lastMessage.content, PREVIEW_LENGTH) }
      : null,
    awaitingReply: row.lastMessage?.direction === "in",
    crmLinkVia: row.crmLinkVia,
  };
}

export function toMessage(message: MessageRow, names: Map<string, string>) {
  return {
    id: message.id,
    direction: message.direction,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    sentBy: person(message.sentBy, names),
  };
}

/**
 * A CPF link never reveals the stored client: whoever typed the CPF may not
 * own it. CRM trouble degrades to "name unavailable", never to an error.
 */
export async function resolveCustomer(
  row: InboxRow,
  port: CustomerNamePort | undefined,
  log: FastifyBaseLogger,
): Promise<CustomerView> {
  if (!row.crmLinkVia || !row.crmClientId) return { linkVia: null };
  if (row.crmLinkVia === "cpf") return { linkVia: "cpf", unverified: true };
  if (!port) return { linkVia: row.crmLinkVia, name: null };
  try {
    return { linkVia: row.crmLinkVia, name: await port.findName(row.crmClientId) };
  } catch (error) {
    log.warn({ err: error }, "CRM name lookup failed");
    return { linkVia: row.crmLinkVia, name: null };
  }
}
