create table if not exists instances (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  evolution_instance_id text not null unique,
  status text not null default 'disconnected',
  phone_number text,
  created_at timestamptz not null default now()
);

create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  provider text not null,
  model text not null,
  system_prompt text not null default '',
  instance_id uuid not null references instances(id) on delete cascade,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references instances(id) on delete cascade,
  contact_phone text not null,
  agent_id uuid references agents(id) on delete set null,
  status text not null default 'open',
  last_message_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  content text not null,
  role text not null,
  evolution_message_id text,
  created_at timestamptz not null default now()
);

alter table instances enable row level security;
alter table agents enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;

create policy "authenticated_full_access" on instances for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on agents for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on conversations for all to authenticated using (true) with check (true);
create policy "authenticated_full_access" on messages for all to authenticated using (true) with check (true);
