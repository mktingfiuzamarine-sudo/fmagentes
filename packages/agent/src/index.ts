export { normalizeCpf, isValidCpf } from "./cpf";
export { buildPrompt, customerContextBlock, PLATFORM_INSTRUCTIONS } from "./buildPrompt";
export type { CrmClient, CrmPort, NewCrmClient } from "./crm/CrmPort";
export { CrmCpfTakenError, AGENT_CREATED_NOTE, createSupabaseCrm } from "./crm/supabaseCrm";
export { phoneMatchSuffixes } from "./crm/phoneMatch";
export { HANDOFF_TOOL_NAME, handoffTool } from "./tools/handoff";
export {
  REGISTER_TOOL_NAME,
  createRegisterCustomerTool,
  registerCustomer,
  type RegistrationOutcome,
} from "./tools/registerCustomer";
export { LlmResponder, DEFAULT_LLM_TIMEOUT_MS, MAX_STEPS, type LlmResponderOptions } from "./LlmResponder";
