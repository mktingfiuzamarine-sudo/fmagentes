export interface LockHandle {
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

/** Always acquires. For unit tests and single-process local runs. */
export const noopLock: ConversationLock = {
  async acquire() {
    return { async release() {} };
  },
};
