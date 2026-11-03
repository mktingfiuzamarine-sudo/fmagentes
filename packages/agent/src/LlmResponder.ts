import { APICallError, generateText, type CoreTool, type LanguageModel } from "ai";
import { getModel, type LlmConfig, type LlmProvider } from "@fmagentes/shared";
import {
  ResponderConfigurationError,
  type AgentConfig,
  type LinkedCustomer,
  type ResponderInput,
  type ResponderPort,
  type ResponderResult,
} from "@fmagentes/messaging";
import { buildPrompt } from "./buildPrompt";
import type { CrmPort, CrmScope, CrmSnapshot } from "./crm/CrmPort";
import { HANDOFF_TOOL_NAME, handoffTool } from "./tools/handoff";
import { createRegisterCustomerTool, REGISTER_TOOL_NAME, type RegistrationOutcome } from "./tools/registerCustomer";
import { createRegisterDealTool, REGISTER_DEAL_TOOL_NAME } from "./tools/registerDeal";
import { createRegisterVesselTool, REGISTER_VESSEL_TOOL_NAME } from "./tools/registerVessel";
import { createUpdateCustomerTool, UPDATE_CUSTOMER_TOOL_NAME } from "./tools/updateCustomer";

export const DEFAULT_LLM_TIMEOUT_MS = 45_000;
/** Tool call → tool result → final text. */
export const MAX_STEPS = 3;

const STEPS_EXHAUSTED_SUMMARY = "O bot não concluiu a resposta (usou todas as etapas em ferramentas). Veja o histórico.";

/** Statuses that mean the agent's configuration is wrong, not that the call failed. */
const CONFIGURATION_STATUSES = new Set([401, 403, 404]);

export interface LlmResponderOptions {
  llm: LlmConfig;
  crm: CrmPort;
  timeoutMs?: number;
  /** Test seam; production builds models with getModel. */
  createModel?: (provider: LlmProvider, model: string) => LanguageModel;
}

export class LlmResponder implements ResponderPort {
  constructor(private readonly options: LlmResponderOptions) {}

  async generate(input: ResponderInput): Promise<ResponderResult> {
    const model = this.modelFor(input.agent);
    const outcome: RegistrationOutcome = {};

    // Registration is only offered while the customer is unregistered, so a
    // registered conversation can never be re-linked by the model. CRM writes
    // need a registered customer; the ficha is only writable on a verified link.
    const { customer } = input;
    let tools: Record<string, CoreTool>;
    let snapshot: CrmSnapshot | undefined;
    if (customer.status === "unregistered") {
      tools = {
        [HANDOFF_TOOL_NAME]: handoffTool,
        [REGISTER_TOOL_NAME]: createRegisterCustomerTool(this.options.crm, input.contactPhone, outcome),
      };
    } else {
      const scope: CrmScope = { clientId: customer.crmClientId, verified: customer.verified, conversationId: input.conversationId };
      // A CRM failure propagates: the job retries.
      snapshot = await this.options.crm.loadSnapshot(scope);
      tools = {
        [HANDOFF_TOOL_NAME]: handoffTool,
        ...(customer.verified ? { [UPDATE_CUSTOMER_TOOL_NAME]: createUpdateCustomerTool(this.options.crm, scope) } : {}),
        [REGISTER_VESSEL_TOOL_NAME]: createRegisterVesselTool(this.options.crm, scope),
        [REGISTER_DEAL_TOOL_NAME]: createRegisterDealTool(this.options.crm, scope),
      };
    }

    let result;
    try {
      result = await generateText({
        model,
        messages: buildPrompt({ ...input, snapshot }),
        tools,
        maxSteps: MAX_STEPS,
        // BullMQ owns retries (3 attempts with backoff); the SDK must not stack its own.
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS),
      });
    } catch (error) {
      throw classify(error, input.agent);
    }

    const link = withLink(outcome.linked);
    const handoffCall = result.steps
      .flatMap((step) => step.toolCalls)
      .find((call) => call.toolName === HANDOFF_TOOL_NAME);
    if (handoffCall) {
      const summary = String((handoffCall.args as { resumo?: unknown }).resumo ?? "").trim();
      return { kind: "handoff", summary, ...link };
    }

    const text = result.text.trim();
    if (text.length > 0) return { kind: "reply", text, ...link };
    // Every step went to tool calls and the step budget ran out before any
    // text: the customer would get silence, so a human takes over.
    if (result.steps.length >= MAX_STEPS && result.finishReason === "tool-calls") {
      return { kind: "handoff", summary: STEPS_EXHAUSTED_SUMMARY, ...link };
    }
    return { kind: "decline", ...link };
  }

  private modelFor(agent: AgentConfig): LanguageModel {
    const provider = agent.provider;
    if (provider !== "anthropic" && provider !== "openai") {
      throw new ResponderConfigurationError(agent.id, `Agent ${agent.id} has unknown provider "${provider}"`);
    }
    const key = provider === "anthropic" ? this.options.llm.anthropicApiKey : this.options.llm.openaiApiKey;
    if (!key) {
      throw new ResponderConfigurationError(agent.id, `No API key configured for ${provider} (agent ${agent.id})`);
    }
    if (this.options.createModel) return this.options.createModel(provider, agent.model);
    return getModel(this.options.llm, provider, agent.model, { cacheControl: provider === "anthropic" });
  }
}

function withLink(linked: LinkedCustomer | undefined): { linkedCustomer?: LinkedCustomer } {
  return linked ? { linkedCustomer: linked } : {};
}

/** Anthropic answers an exhausted balance with a plain 400; only its message tells it apart. */
const OUT_OF_CREDIT = /credit balance is too low/i;

function isConfigurationError(error: APICallError): boolean {
  if (error.statusCode === undefined) return false;
  return CONFIGURATION_STATUSES.has(error.statusCode) || (error.statusCode === 400 && OUT_OF_CREDIT.test(error.message));
}

/** Configuration errors become ResponderConfigurationError; everything else is rethrown as is. */
function classify(error: unknown, agent: AgentConfig): unknown {
  if (APICallError.isInstance(error) && isConfigurationError(error)) {
    return new ResponderConfigurationError(
      agent.id,
      `LLM rejected agent ${agent.id} (${agent.provider}/${agent.model}) with HTTP ${error.statusCode}: ${error.message}`,
    );
  }
  return error;
}
