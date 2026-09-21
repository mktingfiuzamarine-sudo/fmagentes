-- Sub-project 3 verification: the pipeline skips conversations with no active
-- agent, so one must exist for the instance under test.
-- Replace :instance_id with the instances.id you are exercising.
insert into agents (name, provider, model, system_prompt, instance_id, is_active)
values ('Echo de teste', 'echo', 'echo-v1', '', :'instance_id', true);
