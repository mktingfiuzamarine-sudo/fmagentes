export { normalizeCpf, isValidCpf } from "./cpf";
export { buildPrompt, customerContextBlock, PLATFORM_INSTRUCTIONS } from "./buildPrompt";
export type { CrmClient, CrmPort, NewCrmClient } from "./crm/CrmPort";
export { CrmCpfTakenError, AGENT_CREATED_NOTE, createSupabaseCrm } from "./crm/supabaseCrm";
export { phoneMatchSuffixes } from "./crm/phoneMatch";
