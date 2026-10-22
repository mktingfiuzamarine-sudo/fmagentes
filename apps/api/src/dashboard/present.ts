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

/** A CPF link never names the client: whoever typed the CPF may not own it. */
function namedClientId(row: InboxRow): string | null {
  return row.crmClientId && (row.crmLinkVia === "phone" || row.crmLinkVia === "created") ? row.crmClientId : null;
}

/** CRM trouble degrades to "no names", never to an error. */
export async function lookupCustomerNames(
  rows: InboxRow[],
  port: CustomerNamePort | undefined,
  log: FastifyBaseLogger,
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map(namedClientId).filter((id): id is string => id !== null))];
  if (!port || ids.length === 0) return new Map();
  try {
    return await port.findNames(ids);
  } catch (error) {
    log.warn({ err: error }, "CRM name lookup failed");
    return new Map();
  }
}

export function toListItem(row: InboxRow, names: Map<string, string>, customers: Map<string, string>) {
  const clientId = namedClientId(row);
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
    customerName: clientId ? customers.get(clientId) ?? null : null,
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

export function toCustomerView(row: InboxRow, customers: Map<string, string>): CustomerView {
  if (!row.crmLinkVia || !row.crmClientId) return { linkVia: null };
  if (row.crmLinkVia === "cpf") return { linkVia: "cpf", unverified: true };
  return { linkVia: row.crmLinkVia, name: customers.get(row.crmClientId) ?? null };
}
