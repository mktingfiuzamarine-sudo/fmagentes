export interface CrmClient {
  id: string;
  name: string;
  phone: string | null;
  notes: string | null;
}

export interface NewCrmClient {
  name: string;
  /** Digits only. */
  cpf: string;
  email: string;
  phone: string;
}

/**
 * The agent's view of the CRM. Today a Supabase adapter; an HTTP API can
 * replace it without touching the tools.
 */
export interface CrmPort {
  /** null when nobody, or more than one client, matches. */
  findByPhone(phone: string): Promise<CrmClient | null>;
  findById(id: string): Promise<CrmClient | null>;
  findByCpf(cpf: string): Promise<CrmClient | null>;
  /** Throws CrmCpfTakenError when the CPF already exists. */
  create(input: NewCrmClient): Promise<CrmClient>;
  /**
   * Records the extra WhatsApp number in notes; never writes phone — a CPF
   * typed by a stranger must not make their number identify the client.
   */
  attachPhone(clientId: string, phone: string): Promise<void>;
}

export class CrmCpfTakenError extends Error {
  constructor() {
    super("CPF already registered in the CRM");
    this.name = "CrmCpfTakenError";
  }
}
