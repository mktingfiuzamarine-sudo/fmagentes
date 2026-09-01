-- Postgres does not auto-index foreign keys. Without these, every `on delete
-- cascade` from instances/conversations and every "rows for a given parent"
-- lookup does a sequential scan that degrades as the tables grow.

create index if not exists agents_instance_id_idx on agents (instance_id);
create index if not exists conversations_instance_id_idx on conversations (instance_id);
create index if not exists conversations_agent_id_idx on conversations (agent_id);
create index if not exists messages_conversation_id_idx on messages (conversation_id);
