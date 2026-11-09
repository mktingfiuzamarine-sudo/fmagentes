/** Which CRM deals a conversation may mark: the same scope the agent works in. */
export interface AlertScope {
  crmClientId: string;
  /** false on a CPF-typed link: only deals this conversation created are candidates. */
  verified: boolean;
  conversationId: string;
}

/** Marks the CRM card of the subject when a conversation is handed to a human. */
export interface DealAlertPort {
  /** dealId if it is an open deal of the client in scope, else the client's most recently updated open deal in scope, else null. */
  resolveAlertDeal(scope: AlertScope, dealId?: string): Promise<string | null>;
  setDealWaiting(dealId: string): Promise<void>;
}
