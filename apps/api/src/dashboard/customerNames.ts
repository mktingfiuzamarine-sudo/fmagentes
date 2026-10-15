import type { SupabaseClient } from "@supabase/supabase-js";

/** Reads a CRM client's name by id. The API never writes to the CRM. */
export interface CustomerNamePort {
  findName(crmClientId: string): Promise<string | null>;
}

export function createSupabaseCustomerNames(crm: SupabaseClient): CustomerNamePort {
  return {
    async findName(crmClientId) {
      const { data, error } = await crm.from("clients").select("name").eq("id", crmClientId).maybeSingle();
      if (error) throw new Error(`CRM: ${error.message}`);
      return (data as { name: string } | null)?.name ?? null;
    },
  };
}
