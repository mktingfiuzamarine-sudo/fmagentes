-- Sub-project 5: dashboard. Advisory assignment, author of human messages,
-- team display names and a one-query inbox view.

alter table conversations
  add column assigned_to uuid,
  add column assigned_at timestamptz;

comment on column conversations.assigned_to is
  'auth.users.id of the attendant who took the handoff (advisory, no FK: auth schema).';

alter table messages
  add column sent_by uuid;

comment on column messages.sent_by is
  'auth.users.id of the human who sent this outbound message; null for bot and customer.';

create table team_members (
  user_id uuid primary key,
  display_name text not null check (length(trim(display_name)) > 0),
  created_at timestamptz not null default now()
);

alter table team_members enable row level security;
create policy "authenticated_full_access" on team_members
  for all to authenticated using (true) with check (true);

create index idx_conversations_status_last on conversations (status, last_message_at);
create index idx_messages_conversation_received on messages (conversation_id, received_at desc);

-- One row per conversation with its number's name and latest message
-- (database receipt order, so device clocks cannot reorder it).
create view conversation_inbox
with (security_invoker = true) as
select
  c.id,
  c.instance_id,
  i.name as instance_name,
  c.contact_phone,
  c.status,
  c.handoff_summary,
  c.handoff_at,
  c.assigned_to,
  c.assigned_at,
  c.crm_client_id,
  c.crm_link_via,
  c.last_message_at,
  lm.direction as last_direction,
  lm.content as last_content,
  lm.created_at as last_created_at
from conversations c
join instances i on i.id = c.instance_id
left join lateral (
  select m.direction, m.content, m.created_at
  from messages m
  where m.conversation_id = c.id
  order by m.received_at desc
  limit 1
) lm on true;
