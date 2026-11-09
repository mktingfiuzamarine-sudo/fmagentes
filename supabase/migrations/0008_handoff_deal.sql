-- CRM deal whose card shows the "asked for a human" alert. No FK: the deal
-- lives in the CRM database.
alter table public.conversations add column handoff_deal_id uuid null;
