export { normalizeCpf, isValidCpf } from "./cpf";
export { isValidCnpj, isValidCpfOrCnpj } from "./cnpj";
export { buildPrompt, customerContextBlock, PLATFORM_INSTRUCTIONS } from "./buildPrompt";
export type {
  ClientFieldId,
  ClientFields,
  CrmClient,
  CrmPort,
  CrmScope,
  CrmSnapshot,
  DealFields,
  FillResult,
  NewCrmClient,
  VesselFields,
} from "./crm/CrmPort";
export { CrmCpfTakenError, CrmNotInScopeError, CrmVesselKindMismatchError, AGENT_CREATED_NOTE, createSupabaseCrm } from "./crm/supabaseCrm";
export { phoneMatchSuffixes } from "./crm/phoneMatch";
export { HANDOFF_TOOL_NAME, handoffTool } from "./tools/handoff";
export {
  REGISTER_TOOL_NAME,
  createRegisterCustomerTool,
  registerCustomer,
  type RegistrationOutcome,
} from "./tools/registerCustomer";
export { UPDATE_CUSTOMER_TOOL_NAME, createUpdateCustomerTool, updateCustomer, type UpdateCustomerArgs } from "./tools/updateCustomer";
export { REGISTER_VESSEL_TOOL_NAME, createRegisterVesselTool, registerVessel, type RegisterVesselArgs } from "./tools/registerVessel";
export { REGISTER_DEAL_TOOL_NAME, createRegisterDealTool, registerDeal, type RegisterDealArgs } from "./tools/registerDeal";
export { LlmResponder, DEFAULT_LLM_TIMEOUT_MS, MAX_STEPS, type LlmResponderOptions } from "./LlmResponder";
