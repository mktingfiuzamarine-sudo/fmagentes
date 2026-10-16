import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeCpf } from "../cpf";
import { CrmCpfTakenError, type CrmClient, type CrmPort, type NewCrmClient } from "./CrmPort";
import { phoneMatchSuffixes } from "./phoneMatch";

export { CrmCpfTakenError } from "./CrmPort";

export const AGENT_CREATED_NOTE = "Cadastrado pelo agente WhatsApp";

const COLUMNS = "id, name, phone, notes";
const UNIQUE_VIOLATION = "23505";

function throwIfError(error: unknown): void {
  if (error) {
    const message =
      typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "CRM error";
    throw new Error(message);
  }
}

const digitsOf = (value: string) => value.replace(/\D/g, "");

/** Tries before attachPhone gives up on a notes field that keeps changing. */
const ATTACH_ATTEMPTS = 3;

/**
 * Direct access to the CRM's Supabase project with its service key (bypasses
 * the CRM's RLS by design — runs server-side only). Never writes phone_digits
 * or search_vector: both are generated columns.
 */
export function createSupabaseCrm(
  supabase: SupabaseClient,
  options: { agentUserId: string; warn?: (message: string) => void },
): CrmPort {
  const warn = options.warn ?? ((message: string) => console.warn(message));

  async function findById(id: string): Promise<CrmClient | null> {
    const result = await supabase.from("clients").select(COLUMNS).eq("id", id).maybeSingle();
    throwIfError(result.error);
    return result.data as CrmClient | null;
  }

  return {
    async findByPhone(phone) {
      const suffixes = phoneMatchSuffixes(phone);
      if (suffixes.length === 0) return null;

      const result = await supabase
        .from("clients")
        .select(COLUMNS)
        .or(suffixes.map((suffix) => `phone_digits.like.*${suffix}`).join(","))
        .limit(2);
      throwIfError(result.error);

      const rows = (result.data as CrmClient[] | null) ?? [];
      if (rows.length > 1) {
        warn(`[crm] phone matched ${rows.length} clients (${rows.map((r) => r.id).join(", ")}); treating as not found`);
        return null;
      }
      return rows[0] ?? null;
    },

    findById,

    async findByCpf(cpf) {
      const result = await supabase.from("clients").select(COLUMNS).eq("cpf", normalizeCpf(cpf)).maybeSingle();
      throwIfError(result.error);
      return result.data as CrmClient | null;
    },

    async create(input: NewCrmClient) {
      const result = await supabase
        .from("clients")
        .insert({
          user_id: options.agentUserId,
          name: input.name,
          cpf: input.cpf,
          email: input.email,
          phone: input.phone,
          notes: AGENT_CREATED_NOTE,
        })
        .select(COLUMNS)
        .single();
      if (result.error && (result.error as { code?: string }).code === UNIQUE_VIOLATION) throw new CrmCpfTakenError();
      throwIfError(result.error);
      return result.data as CrmClient;
    },

    async attachPhone(clientId, phone) {
      // Never write `phone`: a CPF typed by a stranger must not make their
      // number identify this client (phone_digits is generated from phone).
      const phoneDigits = digitsOf(phone);
      // Unverified: whoever typed this CPF may not be the client.
      const line = `Outro WhatsApp (não verificado): ${phone}`;

      // Compare-and-swap on notes: two conversations attaching at once must
      // not drop each other's line (a read-modify-write over PostgREST).
      for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
        const current = await findById(clientId);
        if (!current) throw new Error(`CRM client not found: ${clientId}`);
        if (current.phone && digitsOf(current.phone) === phoneDigits) return;
        if (current.notes?.includes(phoneDigits)) return;

        const notes = current.notes ? `${current.notes}\n${line}` : line;
        const update = supabase.from("clients").update({ notes }).eq("id", clientId);
        const guarded = current.notes === null ? update.is("notes", null) : update.eq("notes", current.notes);
        const result = await guarded.select("id");
        throwIfError(result.error);
        if ((result.data ?? []).length > 0) return;
      }
      throw new Error(`CRM client ${clientId}: notes kept changing; phone not attached`);
    },
  };
}
