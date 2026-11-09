import { APICallError, generateText, type CoreMessage, type CoreTool, type LanguageModel } from "ai";
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
/** Room for several saves (one tool call each) plus the final text. */
export const MAX_STEPS = 6;

/** Words of a reply that promises to do something later, which never happens: nothing runs after the reply. */
const PROMISE_TO_ACT =
  /\bum (momento|minuto|instante)(zinho)?\b|\baguard[ea]\b|\bvou (registrar|verificar|anotar|consultar|checar|cadastrar|confirmar)\b|\bj[aá] volto\b/i;
const ACT_NOW_NUDGE =
  "Sua resposta prometeu fazer algo depois, mas nada acontece depois: o cliente só recebe a sua resposta final. Se precisa gravar algo, chame a ferramenta agora e então escreva a resposta final, sem prometer ações futuras. Se é algo que você não pode fazer (estoque, disponibilidade, prazo, preço), transfira para um atendente humano.";

/** Words of a reply that says something was saved ("registrei", "foi registrado", "anotei"...). */
const CLAIMS_SAVED = /\b(registrei|anotei|cadastrei|gravei)\b|\bfoi (registrad|anotad|cadastrad)[oa]\b|\b(est[aá]|ficou) (registrad|anotad|cadastrad)[oa]\b/i;
const SAVE_NOW_NUDGE =
  "Sua resposta diz que algo foi registrado, mas você não chamou nenhuma ferramenta nesta resposta, então nada foi gravado. Se há algo novo para registrar, chame a ferramenta agora e então escreva a resposta final. Se já estava registrado antes, diga isso sem afirmar que registrou agora.";

const STEPS_EXHAUSTED_SUMMARY = "O bot não concluiu a resposta (usou todas as etapas em ferramentas). Veja o histórico.";

/** Statuses that mean the agent's configuration is wrong, not that the call failed. */
const CONFIGURATION_STATUSES = new Set([401, 403, 404]);

export interface LlmResponderOptions {
  llm: LlmConfig;
  crm: CrmPort;
  timeoutMs?: number;
  /** Test seam; production builds models with getModel. */
  createModel?: (provider: LlmProvider, model: string) => LanguageModel;
  /** One line per tool call (name, args, answer), to see what the model saved. */
  logToolCall?: (line: string) => void;
}

/**
 * Argument values safe to log (ids, catalog choices, vessel specs). Any other argument (CPF, e-mail,
 * name, free text in the customer's words) is logged by key only.
 */
const LOGGED_VALUES = new Set([
  "funil", "tipo", "tipo_produto", "embarcacao_id", "tipo_casco", "quantidade_motores", "tipo_motor",
  "marca", "modelo", "ano", "marca_motor", "potencia_hp", "ano_motor", "ano_barco", "tamanho_metros", "tamanho_pes", "origem",
]);
const MAX_LOG_PART = 300;

function shownArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args)
    .map(([key, value]) => (LOGGED_VALUES.has(key) ? `${key}=${JSON.stringify(value)}` : key))
    .join(" ");
}

function toolCallLine(conversationId: string, toolName: string, args: unknown, answer: unknown): string {
  const shownAnswer = typeof answer === "string" ? answer : JSON.stringify(answer);
  return `[tool] conv ${conversationId} ${toolName} ${shownArgs(args).slice(0, MAX_LOG_PART)} -> ${String(shownAnswer).slice(0, MAX_LOG_PART)}`;
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

    const abortSignal = AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS);
    const run = async (messages: CoreMessage[]) => {
      try {
        return await generateText({
          model,
          messages,
          tools,
          maxSteps: MAX_STEPS,
          // BullMQ owns retries (3 attempts with backoff); the SDK must not stack its own.
          maxRetries: 0,
          abortSignal,
        });
      } catch (error) {
        throw classify(error, input.agent);
      }
    };

    const prompt = buildPrompt({ ...input, snapshot });
    let result = await run(prompt);
    const steps = [...result.steps];
    const hasHandoff = () => steps.some((step) => step.toolCalls.some((call) => call.toolName === HANDOFF_TOOL_NAME));
    // The customer never gets a "later": a promise to act is not sent, the
    // model is asked once to act now and write the final answer.
    // Nor a claim of having saved when no tool ran in this turn.
    const savedSomething = steps.some((step) => step.toolCalls.some((call) => call.toolName !== HANDOFF_TOOL_NAME));
    const nudge = hasHandoff()
      ? undefined
      : PROMISE_TO_ACT.test(result.text)
        ? ACT_NOW_NUDGE
        : CLAIMS_SAVED.test(result.text) && !savedSomething
          ? SAVE_NOW_NUDGE
          : undefined;
    if (nudge) {
      result = await run([...prompt, ...result.responseMessages, { role: "system", content: nudge }]);
      steps.push(...result.steps);
    }

    const log = this.options.logToolCall;
    if (log) {
      for (const step of steps) {
        for (const call of step.toolResults as { toolName: string; args: unknown; result: unknown }[]) {
          log(toolCallLine(input.conversationId, call.toolName, call.args, call.result));
        }
      }
    }

    const link = withLink(outcome.linked);
    const handoffCall = steps
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
