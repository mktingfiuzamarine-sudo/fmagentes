import { DelayedError, UnrecoverableError, type Job } from "bullmq";
import {
  ConversationBusyError,
  ResponderConfigurationError,
  respondToInboundMessage,
  type InboundJobData,
  type RespondDeps,
  type RespondResult,
} from "@fmagentes/messaging";

export const DEFAULT_BUSY_RETRY_MS = 2000;

interface Options {
  retryDelayMs?: number;
  /** Seam for tests; production always uses the real operation. */
  respond?: typeof respondToInboundMessage;
}

export function createInboundProcessor(deps: RespondDeps, options: Options = {}) {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_BUSY_RETRY_MS;
  const respond = options.respond ?? respondToInboundMessage;

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
        // A wrong key, provider or model will fail every attempt; stop retrying.
        console.error(`[worker] agent ${error.agentId} is misconfigured: ${error.message}`);
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}
