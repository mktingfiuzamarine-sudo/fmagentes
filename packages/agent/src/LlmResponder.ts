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
import type { CrmPort } from "./crm/CrmPort";
import { HANDOFF_TOOL_NAME, handoffTool } from "./tools/handoff";
import { createRegisterCustomerTool, type RegistrationOutcome } from "./tools/registerCustomer";

export const DEFAULT_LLM_TIMEOUT_MS = 45_000;
/** Tool call → tool result → final text. */
export const MAX_STEPS = 3;

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
    // registered conversation can never be re-linked by the model.
    const tools: Record<string, CoreTool> =
      input.customer.status === "unregistered"
        ? {
            transferir_para_humano: handoffTool,
            cadastrar_cliente: createRegisterCustomerTool(this.options.crm, input.contactPhone, outcome),
          }
        : { transferir_para_humano: handoffTool };

    let result;
    try {
      result = await generateText({
        model,
        messages: buildPrompt(input),
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

/** Configuration errors become ResponderConfigurationError; everything else is rethrown as is. */
function classify(error: unknown, agent: AgentConfig): unknown {
  if (APICallError.isInstance(error) && error.statusCode !== undefined && CONFIGURATION_STATUSES.has(error.statusCode)) {
    return new ResponderConfigurationError(
      agent.id,
      `LLM rejected agent ${agent.id} (${agent.provider}/${agent.model}) with HTTP ${error.statusCode}: ${error.message}`,
    );
  }
  return error;
}
