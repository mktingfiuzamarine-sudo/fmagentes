import type { MessagingDeps } from "./deps";
import type { InboundMessageEvent } from "./events";
import { assertNoError } from "./internal/supabaseError";

export interface IngestResult {
  messageId: string;
  conversationId: string;
  instanceId: string;
}

export async function ingestInboundMessage(
  deps: MessagingDeps,
  event: InboundMessageEvent,
): Promise<IngestResult | null> {
  if (event.text === null) return null;

  const instanceLookup = await deps.supabase
    .from("instances")
    .select("id")
    .eq("evolution_instance_id", event.instanceName)
    .maybeSingle();
  assertNoError(instanceLookup.error);
  const instanceId = (instanceLookup.data as { id: string } | null)?.id;
  if (!instanceId) return null;

  const upsertConv = await deps.supabase
    .from("conversations")
    .upsert(
      { instance_id: instanceId, contact_phone: event.contactPhone },
      { onConflict: "instance_id,contact_phone", ignoreDuplicates: true },
    );
  assertNoError(upsertConv.error);

  const convLookup = await deps.supabase
    .from("conversations")
    .select("id")
    .eq("instance_id", instanceId)
    .eq("contact_phone", event.contactPhone)
    .single();
  assertNoError(convLookup.error);
  const conversationId = (convLookup.data as { id: string }).id;

  const insertMsg = await deps.supabase
    .from("messages")
    .upsert(
      {
        conversation_id: conversationId,
        direction: "in",
        role: "user",
        content: event.text,
        evolution_message_id: event.messageId,
        created_at: event.timestamp ? new Date(event.timestamp * 1000).toISOString() : undefined,
      },
      { onConflict: "evolution_message_id", ignoreDuplicates: true },
    )
    .select("id");
  assertNoError(insertMsg.error);

  const rows = (insertMsg.data as Array<{ id: string }> | null) ?? [];
  if (rows.length === 0) return null;

  await deps.supabase
    .from("conversations")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", conversationId);

  return { messageId: rows[0].id, conversationId, instanceId };
}
