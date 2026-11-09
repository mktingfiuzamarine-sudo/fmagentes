import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AGENT_DEAL_FIELDS,
  CLIENT_FIELD_LABELS,
  DEAL_FIELD_LABELS,
  PIPELINE_IDS,
  STAGES,
  VESSEL_FIELD_LABELS,
  lastStage,
  type PipelineId,
  type VesselFieldId,
  type VesselKind,
} from "./catalog";
import {
  CLIENT_FIELD_IDS,
  CrmNotInScopeError,
  CrmVesselKindMismatchError,
  type ClientFieldId,
  type CrmPort,
  type CrmScope,
  type FillResult,
} from "./CrmPort";
import { describeDeal, describeVessel, type VesselRow } from "./describe";
import { planFill } from "./fill";
import { isUuid } from "../tools/crmAnswers";

type RecordMethods = Pick<
  CrmPort,
  | "loadSnapshot"
  | "fillClient"
  | "createVessel"
  | "fillVessel"
  | "findOpenDeals"
  | "createDeal"
  | "fillDeal"
  | "resolveAlertDeal"
  | "setDealWaiting"
>;
type Row = Record<string, unknown>;

/** Tries before a compare-and-swap write gives up on a record that keeps changing. */
export const CAS_ATTEMPTS = 3;
const SNAPSHOT_LIMIT = 20;

const VESSEL_FIELD_IDS = (Object.keys(VESSEL_FIELD_LABELS) as (keyof typeof VESSEL_FIELD_LABELS)[]).filter(
  (k): k is VesselFieldId => k !== "notes",
);
const DEAL_FIELD_IDS = [...new Set(PIPELINE_IDS.flatMap((p) => AGENT_DEAL_FIELDS[p] as readonly string[]))];

const SCOPE_COLUMNS = "id, client_id, created_by_conversation";
const CLIENT_COLUMNS = ["id", ...CLIENT_FIELD_IDS, "notes", "updated_at"].join(", ");
const VESSEL_COLUMNS = [SCOPE_COLUMNS, "kind", ...VESSEL_FIELD_IDS, "notes", "updated_at"].join(", ");
const DEAL_COLUMNS = [SCOPE_COLUMNS, "pipeline", ...DEAL_FIELD_IDS, "notes", "updated_at"].join(", ");

/** Only the allowlisted keys survive; anything else (notes, user_id, olist_*…) is dropped before planning or writing. */
function pick(fields: object, allowed: readonly string[]): Row {
  const out: Row = {};
  for (const [key, value] of Object.entries(fields)) if (allowed.includes(key)) out[key] = value;
  return out;
}

const blank = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

/** Saved vs given value: numbers by value (numeric columns may come back as text), text ignoring case and spaces. */
function sameValue(saved: unknown, given: unknown): boolean {
  if (blank(saved)) return false;
  if (typeof given === "number") return Number(saved) === given;
  return String(saved).trim().toLowerCase() === String(given).trim().toLowerCase();
}

function inScope(row: Row | null, scope: CrmScope): row is Row {
  return (
    !!row &&
    row.client_id === scope.clientId &&
    (scope.verified || row.created_by_conversation === scope.conversationId)
  );
}

/** What the agent stamps on records it creates: a verified link's records belong to the client. */
const conversationStamp = (scope: CrmScope) => (scope.verified ? null : scope.conversationId);

/**
 * Snapshot reads plus fill-only-empty writes on clients, vessels and deals.
 * Every fill is a compare-and-swap on `updated_at` so a staff edit made while
 * the agent works is never overwritten.
 */
export function createRecordMethods(
  supabase: SupabaseClient,
  agentUserId: string,
  throwIfError: (error: unknown) => void,
): RecordMethods {
  /** Reads `table`/`id`, lets `prepare` validate and choose the incoming fields, then writes guarded by updated_at. */
  async function fillRow(
    table: string,
    id: string,
    columns: string,
    labels: Record<string, string>,
    prepare: (row: Row | null) => Promise<{ incoming: Row; noteLines?: string[] }>,
  ): Promise<FillResult & { row: Row }> {
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      const read = await supabase.from(table).select(columns).eq("id", id).maybeSingle();
      throwIfError(read.error);
      const row = read.data as Row | null;
      const { incoming, noteLines } = await prepare(row);
      if (!row) throw new CrmNotInScopeError();
      const current = row;

      const { patch, filled, conflicts } = planFill(
        current,
        incoming,
        labels,
        (current.notes as string | null) ?? null,
        noteLines,
      );
      if (Object.keys(patch).length === 0) return { filled, conflicts, row: current };

      const write = await supabase
        .from(table)
        .update(patch)
        .eq("id", id)
        .eq("updated_at", current.updated_at as string)
        .select("id");
      throwIfError(write.error);
      if (((write.data as unknown[] | null) ?? []).length > 0) return { filled, conflicts, row: current };
    }
    throw new Error(`CRM ${table} ${id}: kept changing; not filled`);
  }

  async function assertVesselInScope(scope: CrmScope, vesselId: unknown): Promise<void> {
    if (blank(vesselId)) return;
    const result = await supabase.from("vessels").select(SCOPE_COLUMNS).eq("id", String(vesselId)).maybeSingle();
    throwIfError(result.error);
    if (!inScope(result.data as Row | null, scope)) throw new CrmNotInScopeError();
  }

  async function readClientMissing(scope: CrmScope): Promise<ClientFieldId[]> {
    if (!scope.verified) return [];
    const result = await supabase.from("clients").select(CLIENT_COLUMNS).eq("id", scope.clientId).maybeSingle();
    throwIfError(result.error);
    const client = result.data as Row | null;
    if (!client) return [];
    return CLIENT_FIELD_IDS.filter(
      (field) => blank(client[field]) && !(field === "referred_by" && client.lead_source !== "indicacao"),
    );
  }

  /** Vessels/deals of the client; on an unverified link only those this conversation created. */
  function scoped(table: string, columns: string, scope: CrmScope) {
    const query = supabase.from(table).select(columns).eq("client_id", scope.clientId);
    return scope.verified ? query : query.eq("created_by_conversation", scope.conversationId);
  }

  /** Deals not in the last stage of their pipeline. */
  const OPEN_DEALS = PIPELINE_IDS.map((p) => `and(pipeline.eq.${p},stage.neq.${lastStage(p)})`).join(",");

  return {
    async resolveAlertDeal(alert, dealId) {
      const scope: CrmScope = { clientId: alert.crmClientId, verified: alert.verified, conversationId: alert.conversationId };
      if (dealId && isUuid(dealId)) {
        const named = await scoped("deals", "id", scope).eq("id", dealId).or(OPEN_DEALS).maybeSingle();
        throwIfError(named.error);
        const found = named.data as unknown as { id: string } | null;
        if (found) return found.id;
      }
      const latest = await scoped("deals", "id", scope).or(OPEN_DEALS).order("updated_at", { ascending: false }).limit(1);
      throwIfError(latest.error);
      return ((latest.data as unknown as { id: string }[] | null) ?? [])[0]?.id ?? null;
    },

    async setDealWaiting(dealId) {
      const result = await supabase
        .from("deals")
        .update({ attention: "waiting", attention_since: new Date().toISOString(), attention_by: null })
        .eq("id", dealId);
      throwIfError(result.error);
    },

    async loadSnapshot(scope) {
      const missingClientFields = await readClientMissing(scope);

      const vesselsRead = await scoped("vessels", ["id", "kind", ...VESSEL_FIELD_IDS].join(", "), scope)
        .order("created_at", { ascending: false })
        .limit(SNAPSHOT_LIMIT);
      throwIfError(vesselsRead.error);

      const dealsRead = await scoped("deals", ["id", "pipeline", "stage", "title", ...DEAL_FIELD_IDS].join(", "), scope)
        .or(OPEN_DEALS)
        .order("updated_at", { ascending: false })
        .limit(SNAPSHOT_LIMIT);
      throwIfError(dealsRead.error);

      const vessels = ((vesselsRead.data as unknown as (VesselRow & { id: string })[] | null) ?? []).map((v) => ({
        id: v.id,
        kind: v.kind,
        summary: describeVessel(v),
      }));
      const deals =
        (dealsRead.data as unknown as ({ id: string; pipeline: PipelineId; stage: string; title: string } & Row)[] | null) ?? [];
      const openDeals = deals
        .filter((d) => STAGES[d.pipeline] && d.stage !== lastStage(d.pipeline))
        .map((d) => ({
          id: d.id,
          pipeline: d.pipeline,
          stageLabel: STAGES[d.pipeline].find((s) => s.id === d.stage)?.label ?? d.stage,
          title: d.title,
          details: describeDeal(d.pipeline, d),
        }));

      return { missingClientFields, vessels, openDeals };
    },

    async fillClient(scope, fields) {
      if (!scope.verified) throw new CrmNotInScopeError();
      const incoming = pick(fields, CLIENT_FIELD_IDS);
      const { filled, conflicts } = await fillRow("clients", scope.clientId, CLIENT_COLUMNS, CLIENT_FIELD_LABELS, async (row) => {
        if (!row) throw new CrmNotInScopeError();
        // The CRM only accepts referred_by with lead_source = indicacao: otherwise keep the name in notes.
        const referredBy = incoming.referred_by;
        const origin = blank(row.lead_source) ? incoming.lead_source : row.lead_source;
        if (blank(referredBy) || origin === "indicacao") return { incoming };
        const { referred_by: _dropped, ...rest } = incoming;
        return { incoming: rest, noteLines: [`Quem indicou: ${String(referredBy)}`] };
      });
      return { filled, conflicts };
    },

    async createVessel(scope, kind, fields) {
      const given = pick(fields, VESSEL_FIELD_IDS);
      const givenKeys = Object.keys(given).filter((key) => !blank(given[key]));
      if (givenKeys.length > 0) {
        // A retried job (or the customer repeating themselves) must not register the same vessel twice.
        const existing = await scoped("vessels", ["id", ...VESSEL_FIELD_IDS].join(", "), scope)
          .eq("kind", kind)
          .limit(SNAPSHOT_LIMIT);
        throwIfError(existing.error);
        const match = ((existing.data as unknown as Row[] | null) ?? []).find((row) =>
          givenKeys.every((key) => sameValue(row[key], given[key])),
        );
        if (match) return { id: String(match.id) };
      }

      const result = await supabase
        .from("vessels")
        .insert({
          user_id: agentUserId,
          client_id: scope.clientId,
          kind,
          ...given,
          ...(typeof fields.notes === "string" && fields.notes ? { notes: fields.notes } : {}),
          created_by_conversation: conversationStamp(scope),
        })
        .select("id")
        .single();
      throwIfError(result.error);
      return { id: (result.data as { id: string }).id };
    },

    async fillVessel(scope, vesselId, fields, expectedKind, noteLine) {
      const incoming = pick(fields, VESSEL_FIELD_IDS);
      const { filled, conflicts, row } = await fillRow("vessels", vesselId, VESSEL_COLUMNS, VESSEL_FIELD_LABELS, async (r) => {
        if (!inScope(r, scope)) throw new CrmNotInScopeError();
        if (r.kind !== expectedKind) throw new CrmVesselKindMismatchError();
        return { incoming, noteLines: noteLine ? [noteLine] : [] };
      });
      return { filled, conflicts, kind: row.kind as VesselKind };
    },

    async findOpenDeals(scope, pipeline) {
      const result = await scoped("deals", "id, title", scope)
        .eq("pipeline", pipeline)
        .neq("stage", lastStage(pipeline))
        .order("updated_at", { ascending: false })
        .limit(SNAPSHOT_LIMIT);
      throwIfError(result.error);
      return ((result.data as unknown as { id: string; title: string }[] | null) ?? []).map((d) => ({ id: d.id, title: d.title }));
    },

    async createDeal(scope, pipeline, title, fields) {
      const incoming = pick(fields, AGENT_DEAL_FIELDS[pipeline]);
      await assertVesselInScope(scope, incoming.vessel_id);
      const result = await supabase.rpc("agent_create_deal", {
        p_user_id: agentUserId,
        p_client_id: scope.clientId,
        p_pipeline: pipeline,
        p_title: title,
        p_fields: incoming,
        p_conversation_id: conversationStamp(scope),
      });
      throwIfError(result.error);
      return { id: result.data as string };
    },

    async fillDeal(scope, dealId, fields) {
      const { filled, conflicts } = await fillRow("deals", dealId, DEAL_COLUMNS, DEAL_FIELD_LABELS, async (row) => {
        if (!inScope(row, scope)) throw new CrmNotInScopeError();
        const allowed = AGENT_DEAL_FIELDS[row.pipeline as PipelineId] ?? [];
        const incoming = pick(fields, allowed);
        await assertVesselInScope(scope, incoming.vessel_id);
        return { incoming };
      });
      return { filled, conflicts };
    },
  };
}
