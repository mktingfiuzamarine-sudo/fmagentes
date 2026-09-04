-- Sub-project 2: messaging. Enables idempotent webhook ingest and race-free
-- find-or-create of conversations.

alter table messages
  add constraint messages_evolution_message_id_key unique (evolution_message_id);

alter table conversations
  add constraint conversations_instance_contact_key unique (instance_id, contact_phone);

comment on column instances.status is
  'lifecycle: created | connecting | connected | disconnected';
