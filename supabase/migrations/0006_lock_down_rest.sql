-- C1 (code review 2026-10-15): nothing in this database is meant to be
-- reached through the public REST/GraphQL endpoints. The API and the worker use
-- the service role (which bypasses RLS); the dashboard only uses Supabase Auth.
-- The "authenticated_full_access" policies let any signed-up user read and
-- rewrite every table directly, bypassing the API allowlist.
--
-- RLS stays enabled with no policies, and anon/authenticated lose their grants:
-- two independent locks. Also turn off "Allow new users to sign up" in the
-- Supabase dashboard (Authentication → Sign In / Providers).

drop policy if exists "authenticated_full_access" on instances;
drop policy if exists "authenticated_full_access" on agents;
drop policy if exists "authenticated_full_access" on conversations;
drop policy if exists "authenticated_full_access" on messages;
drop policy if exists "authenticated_full_access" on team_members;

revoke all on table instances, agents, conversations, messages, team_members, conversation_inbox
  from anon, authenticated;

-- Tables, sequences and functions created later start closed too.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
