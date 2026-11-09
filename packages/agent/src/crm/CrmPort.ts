import type { AgentDealFieldId, PipelineId, VesselFieldId, VesselKind } from "./catalog";

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
 * Which CRM records this conversation may touch. A record is in scope when it
 * belongs to `clientId` and either the link is verified or the record was
 * created by this very conversation (a typed CPF may be someone else's).
 */
export interface CrmScope {
  clientId: string;
  verified: boolean;
  conversationId: string;
}

export interface FillResult {
  filled: string[];
  conflicts: string[];
}

export interface CrmSnapshot {
  /** Only for a verified link; empty otherwise. */
  missingClientFields: ClientFieldId[];
  vessels: { id: string; kind: VesselKind; summary: string }[];
  openDeals: { id: string; pipeline: PipelineId; stageLabel: string; title: string }[];
}

export const CLIENT_FIELD_IDS = ["email", "landline", "birthday", "lead_source", "referred_by", "company"] as const;
export type ClientFieldId = (typeof CLIENT_FIELD_IDS)[number];
export type ClientFields = Partial<Record<ClientFieldId, string>>;
/** Vessel table columns the agent may fill (never `notes`). */
export type VesselFields = Partial<Record<VesselFieldId, string | number>>;
export type DealFields = Partial<Record<AgentDealFieldId, string | number>>;

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
   * Records the extra WhatsApp number in notes as `Outro WhatsApp (não
   * verificado): {phone}` (deduped by digits); never writes phone — a CPF
   * typed by a stranger must not make their number identify the client.
   */
  attachPhone(clientId: string, phone: string): Promise<void>;

  /** What the agent may know about the client right now (at most 20 vessels and 20 open deals). */
  loadSnapshot(scope: CrmScope): Promise<CrmSnapshot>;
  /**
   * Fills only empty fields; a different saved value becomes a line in notes.
   * Throws CrmNotInScopeError unless `scope.verified`.
   */
  fillClient(scope: CrmScope, fields: ClientFields): Promise<FillResult>;
  /**
   * `notes` is a free-text line (e.g. an unlisted brand). Returns the id of a vessel in scope of the
   * same kind whose saved fields already match every given field instead of inserting a duplicate.
   */
  createVessel(scope: CrmScope, kind: VesselKind, fields: VesselFields & { notes?: string }): Promise<{ id: string }>;
  /**
   * Throws CrmNotInScopeError when the vessel is missing or outside the scope (checked first), then
   * CrmVesselKindMismatchError, writing nothing, when the vessel is not of `expectedKind`.
   * `noteLine` (e.g. an unlisted brand) is appended to notes once.
   */
  fillVessel(
    scope: CrmScope,
    vesselId: string,
    fields: VesselFields,
    expectedKind: VesselKind,
    noteLine?: string,
  ): Promise<FillResult & { kind: VesselKind }>;
  /** Most recently updated deal of that pipeline in scope that is not in its last stage. */
  findOpenDeal(scope: CrmScope, pipeline: PipelineId): Promise<{ id: string } | null>;
  /** Always in the pipeline's first stage. A `vessel_id` outside the scope throws CrmNotInScopeError. */
  createDeal(scope: CrmScope, pipeline: PipelineId, title: string, fields: DealFields): Promise<{ id: string }>;
  /** Throws CrmNotInScopeError when the deal (or a given `vessel_id`) is missing or outside the scope. */
  fillDeal(scope: CrmScope, dealId: string, fields: DealFields): Promise<FillResult>;
}

export class CrmCpfTakenError extends Error {
  constructor() {
    super("CPF already registered in the CRM");
    this.name = "CrmCpfTakenError";
  }
}

/** The vessel in scope is of another kind than the caller expected; nothing was written. */
export class CrmVesselKindMismatchError extends Error {
  constructor() {
    super("CRM vessel is of another kind");
    this.name = "CrmVesselKindMismatchError";
  }
}

/** Deliberately says nothing about the record: missing and out of scope look the same. */
export class CrmNotInScopeError extends Error {
  constructor() {
    super("CRM record not in scope");
    this.name = "CrmNotInScopeError";
  }
}
