export interface LockHandle {
  /**
   * True once a renewal found the lock expired or taken by someone else. The
   * holder must not perform any side effect (send, handoff persist) after this.
   */
  isLost(): boolean;
  release(): Promise<void>;
}

export interface ConversationLock {
  /** Resolves to a handle, or null when another worker holds the lock. */
  acquire(conversationId: string): Promise<LockHandle | null>;
}

/**
 * Thrown when the conversation is already being processed. The worker's
 * processor catches this and reschedules the job instead of failing it, so a
 * busy lock never consumes a retry attempt.
 */
export class ConversationBusyError extends Error {
  constructor(public readonly conversationId: string) {
    super(`Conversation is already being processed: ${conversationId}`);
    this.name = "ConversationBusyError";
  }
}

/**
 * Thrown right before a side effect when the lock was lost mid-job. The job
 * fails and BullMQ retries it; the duplicate guard protects the retry.
 */
export class LockLostError extends Error {
  constructor(public readonly conversationId: string) {
    super(`Conversation lock lost before a side effect: ${conversationId}`);
    this.name = "LockLostError";
  }
}

/** Always acquires. For unit tests and single-process local runs. */
export const noopLock: ConversationLock = {
  async acquire() {
    return { isLost: () => false, async release() {} };
  },
};
