-- Sub-project 4: agent core. Handoff state, link to the CRM client, and a
-- receipt time on the database clock for the duplicate guard.

alter table conversations
  add constraint conversations_status_check check (status in ('open', 'awaiting_human')),
  add column handoff_summary text,
  add column handoff_at timestamptz,
  add column crm_client_id uuid,
  add column crm_link_via text
    constraint conversations_crm_link_via_check check (crm_link_via in ('phone', 'cpf', 'created'));

comment on column conversations.handoff_at is
  'received_at of the inbound message that triggered the handoff (database clock). '
  'While awaiting_human, inbound received after it is left for the human.';
comment on column conversations.crm_client_id is
  'clients.id in the CRM database (a separate Supabase project) - no FK by design.';

alter table agents
  add column handoff_message text not null
    default 'Vou te passar para um atendente, já já alguém te responde.';

-- created_at of inbound rows carries the device timestamp; received_at is
-- always the database's now(), so the guard compares one clock with itself.
alter table messages
  add column received_at timestamptz not null default now();

update messages set received_at = created_at;
