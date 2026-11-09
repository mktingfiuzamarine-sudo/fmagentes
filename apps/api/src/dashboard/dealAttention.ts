import type { SupabaseClient } from "@supabase/supabase-js";

/** The alert on the CRM card of a handed-off conversation, driven by the dashboard buttons. */
export interface DealAttentionPort {
  setInService(dealId: string, attendantName: string): Promise<void>;
  setWaiting(dealId: string): Promise<void>;
  clear(dealId: string): Promise<void>;
}

type Attention = { attention: "waiting" | "in_service" | null; attention_since: string | null; attention_by: string | null };

/** Writes only the attention columns (the CRM trigger leaves updated_at alone for them). */
export function createSupabaseDealAttention(crm: SupabaseClient): DealAttentionPort {
  async function write(dealId: string, values: Attention): Promise<void> {
    const { error } = await crm.from("deals").update(values).eq("id", dealId);
    if (error) throw new Error(`CRM deal attention update failed: ${error.message}`);
  }
  const now = () => new Date().toISOString();
  return {
    setInService: (dealId, attendantName) =>
      write(dealId, { attention: "in_service", attention_since: now(), attention_by: attendantName }),
    setWaiting: (dealId) => write(dealId, { attention: "waiting", attention_since: now(), attention_by: null }),
    clear: (dealId) => write(dealId, { attention: null, attention_since: null, attention_by: null }),
  };
}
