import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import {
  ConversationBusyError,
  ResponderConfigurationError,
  handOffAfterFailure,
  respondToInboundMessage,
  type InboundJobData,
  type RespondDeps,
  type RespondResult,
} from "@fmagentes/messaging";

export const DEFAULT_BUSY_RETRY_MS = 2000;

/** Shown to attendants as the handoff summary. */
const MISCONFIGURED_REASON = "agente mal configurado ou provedor de IA sem crédito";
const EXHAUSTED_REASON = "falha ao gerar resposta após várias tentativas";

interface Options {
  retryDelayMs?: number;
  /** Seams for tests; production always uses the real operations. */
  respond?: typeof respondToInboundMessage;
  handOff?: typeof handOffAfterFailure;
}

export function createInboundProcessor(deps: RespondDeps, options: Options = {}) {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_BUSY_RETRY_MS;
  const respond = options.respond ?? respondToInboundMessage;
  const handOff = options.handOff ?? handOffAfterFailure;

  /** Never lets a hand-off failure replace the error that ended the job. */
  async function handOffQuietly(job: Job<InboundJobData>, reason: string): Promise<void> {
    try {
      const result = await handOff(deps, job.data, reason);
      console.log(`[worker] job ${job.id} message ${job.data.messageId}: failure hand-off ${result.status}`);
    } catch (error) {
      console.error(`[worker] job ${job.id}: failure hand-off failed`, error);
    }
  }

  return async function processInboundJob(
    job: Job<InboundJobData>,
    token?: string,
  ): Promise<RespondResult> {
    try {
      const result = await respond(deps, job.data);
      console.log(`[worker] job ${job.id} message ${job.data.messageId}: ${result.status}`);
      return result;
    } catch (error) {
      if (error instanceof ConversationBusyError) {
        // Another worker holds the conversation. Reschedule without burning an
        // attempt. moveToDelayed must be followed by DelayedError, otherwise
        // BullMQ completes the job and the reschedule is silently dropped.
        await job.moveToDelayed(Date.now() + retryDelayMs, token);
        throw new DelayedError();
      }
      if (error instanceof ResponderConfigurationError) {
        // A wrong key, provider, model or an empty balance fails every attempt:
        // stop retrying, and give the customer a human instead of silence.
        console.error(`[worker] agent ${error.agentId} is misconfigured: ${error.message}`);
        await handOffQuietly(job, MISCONFIGURED_REASON);
        throw new UnrecoverableError(error.message);
      }
      // attemptsMade counts the attempts that already failed.
      if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        await handOffQuietly(job, EXHAUSTED_REASON);
      }
      throw error;
    }
  };
}
