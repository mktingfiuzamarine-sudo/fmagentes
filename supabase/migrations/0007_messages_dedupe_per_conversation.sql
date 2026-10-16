-- M6 (code review 2026-10-15): a WhatsApp message id is unique per chat, not
-- across our numbers. When one of our numbers messages another, the sender's
-- outbound row and the receiver's inbound row share the id, and a global unique
-- dropped the inbound as a "duplicate". ingestInboundMessage upserts on
-- (conversation_id, evolution_message_id) from this migration on.
alter table messages drop constraint messages_evolution_message_id_key;
alter table messages
  add constraint messages_conversation_evolution_message_id_key unique (conversation_id, evolution_message_id);

-- M5: (conversation_id) alone is already the leading column of
-- idx_messages_conversation_received and of the constraint above.
drop index if exists messages_conversation_id_idx;
