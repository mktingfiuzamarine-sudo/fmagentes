-- Sub-project 4 verification: an active LLM agent on the instance under test.
-- Replace :instance_id with the instances.id you are exercising.
-- The oldest active agent wins resolution, and a conversation pinned to a
-- deactivated agent gets no answer, so retire older agents and unpin.
update agents set is_active = false where instance_id = :'instance_id';
update conversations set agent_id = null where instance_id = :'instance_id';

insert into agents (name, provider, model, system_prompt, instance_id, is_active)
values (
  'Atendente de teste',
  'anthropic',
  'claude-haiku-4-5',
  $$Você atende a Loja Exemplo, que vende acessórios náuticos.
Horário: segunda a sexta, 9h às 18h. Entregas para todo o Brasil em até 7 dias úteis.
Para orçamento de produtos sob encomenda, colete o produto desejado e a quantidade e transfira para um atendente.$$,
  :'instance_id',
  true
);
