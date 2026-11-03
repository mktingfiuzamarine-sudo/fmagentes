import { describe, expect, it, vi } from "vitest";
import { CrmNotInScopeError, type CrmScope } from "../src/crm/CrmPort";
import { AGENT_CREATED_NOTE, CrmCpfTakenError, createSupabaseCrm } from "../src/crm/supabaseCrm";
import { createSupabaseMock, type Handler, type TableCall } from "./support/supabaseMock";

const AGENT_USER = "11111111-1111-1111-1111-111111111111";
const ANA = { id: "crm-1", name: "Ana Souza", phone: "(11) 99999-8888", notes: null };

function crmWith(clients: Handler, warn = vi.fn()) {
  const supabase = createSupabaseMock({ clients });
  return { crm: createSupabaseCrm(supabase as never, { agentUserId: AGENT_USER, warn }), supabase, warn };
}

describe("createSupabaseCrm", () => {
  describe("findByPhone", () => {
    it("matches phone_digits by suffix, with and without the ninth digit", async () => {
      let recorded: TableCall = [];
      const { crm } = crmWith((calls) => {
        recorded = calls;
        return { data: [ANA], error: null };
      });

      await expect(crm.findByPhone("5511999998888")).resolves.toEqual(ANA);
      expect(recorded).toContainEqual({ op: "or", args: ["phone_digits.like.*11999998888,phone_digits.like.*1199998888"] });
      expect(recorded).toContainEqual({ op: "limit", args: [2] });
    });

    it("treats more than one match as not found and warns without the phone", async () => {
      const { crm, warn } = crmWith(() => ({ data: [ANA, { ...ANA, id: "crm-2" }], error: null }));

      await expect(crm.findByPhone("5511999998888")).resolves.toBeNull();
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).not.toContain("99999");
    });

    it("returns null without querying for a number too short to match", async () => {
      const { crm, supabase } = crmWith(() => ({ data: [ANA], error: null }));

      await expect(crm.findByPhone("12345")).resolves.toBeNull();
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it("returns null when nobody matches", async () => {
      const { crm } = crmWith(() => ({ data: [], error: null }));
      await expect(crm.findByPhone("5511999998888")).resolves.toBeNull();
    });

    it("throws when the CRM query fails", async () => {
      const { crm } = crmWith(() => ({ data: null, error: { message: "crm down" } }));
      await expect(crm.findByPhone("5511999998888")).rejects.toThrow("crm down");
    });
  });

  it("finds by CPF using digits only", async () => {
    let recorded: TableCall = [];
    const { crm } = crmWith((calls) => {
      recorded = calls;
      return { data: ANA, error: null };
    });

    await expect(crm.findByCpf("529.982.247-25")).resolves.toEqual(ANA);
    expect(recorded).toContainEqual({ op: "eq", args: ["cpf", "52998224725"] });
  });

  describe("create", () => {
    it("creates the client owned by the designated user with the origin note", async () => {
      let recorded: TableCall = [];
      const { crm } = crmWith((calls) => {
        recorded = calls;
        return { data: { id: "crm-new", name: "Bruno", phone: "5511988887777", notes: AGENT_CREATED_NOTE }, error: null };
      });

      await expect(
        crm.create({ name: "Bruno", cpf: "52998224725", email: "bruno@example.com", phone: "5511988887777" }),
      ).resolves.toMatchObject({ id: "crm-new" });
      expect(recorded).toContainEqual({
        op: "insert",
        args: [
          {
            user_id: AGENT_USER,
            name: "Bruno",
            cpf: "52998224725",
            email: "bruno@example.com",
            phone: "5511988887777",
            notes: "Cadastrado pelo agente WhatsApp",
          },
        ],
      });
    });

    it("raises CrmCpfTakenError on a CPF unique violation", async () => {
      const { crm } = crmWith(() => ({ data: null, error: { code: "23505", message: "duplicate key" } }));
      await expect(
        crm.create({ name: "Bruno", cpf: "52998224725", email: "b@example.com", phone: "55119" }),
      ).rejects.toBeInstanceOf(CrmCpfTakenError);
    });
  });

  describe("attachPhone", () => {
    function attachScenario(current: { phone: string | null; notes: string | null }) {
      const updates: unknown[] = [];
      const { crm } = crmWith((calls) => {
        const update = calls.find((c) => c.op === "update");
        if (update) {
          updates.push(update.args[0]);
          return { data: [{ id: "crm-1" }], error: null };
        }
        return { data: { id: "crm-1", name: "Ana", ...current }, error: null };
      });
      return { crm, updates };
    }

    it("notes the number even when the phone is empty (never writes phone)", async () => {
      const { crm, updates } = attachScenario({ phone: "  ", notes: null });
      await crm.attachPhone("crm-1", "5511988887777");
      expect(updates).toEqual([{ notes: "Outro WhatsApp (não verificado): 5511988887777" }]);
    });

    it("notes the number when phone is null and notes exist (never writes phone)", async () => {
      const { crm, updates } = attachScenario({ phone: null, notes: "VIP" });
      await crm.attachPhone("crm-1", "5511988887777");
      expect(updates).toEqual([{ notes: "VIP\nOutro WhatsApp (não verificado): 5511988887777" }]);
    });

    it("appends a note when the client already has another phone", async () => {
      const { crm, updates } = attachScenario({ phone: "(11) 3333-4444", notes: "VIP" });
      await crm.attachPhone("crm-1", "5511988887777");
      expect(updates).toEqual([{ notes: "VIP\nOutro WhatsApp (não verificado): 5511988887777" }]);
    });

    it("does nothing when the note is already there (retry)", async () => {
      const { crm, updates } = attachScenario({ phone: "(11) 3333-4444", notes: "Outro WhatsApp (não verificado): 5511988887777" });
      await crm.attachPhone("crm-1", "5511988887777");
      expect(updates).toEqual([]);
    });

    it("dedupes by digits, whatever the note around them says", async () => {
      const { crm, updates } = attachScenario({ phone: null, notes: "Outro WhatsApp: 5511988887777" });
      await crm.attachPhone("crm-1", "+55 (11) 98888-7777");
      expect(updates).toEqual([]);
    });

    it("writes only if notes did not change since the read (M12)", async () => {
      const guards: TableCall[] = [];
      const { crm } = crmWith((calls) => {
        if (calls.some((c) => c.op === "update")) {
          guards.push(calls.filter((c) => c.op === "eq" || c.op === "is"));
          return { data: [{ id: "crm-1" }], error: null };
        }
        return { data: { id: "crm-1", name: "Ana", phone: null, notes: "VIP" }, error: null };
      });

      await crm.attachPhone("crm-1", "5511988887777");

      expect(guards).toEqual([[{ op: "eq", args: ["id", "crm-1"] }, { op: "eq", args: ["notes", "VIP"] }]]);
    });

    it("re-reads and keeps both lines when another conversation wrote notes first (M12)", async () => {
      const other = "Outro WhatsApp (não verificado): 5511977776666";
      const updates: unknown[] = [];
      let reads = 0;
      const { crm } = crmWith((calls) => {
        if (calls.some((c) => c.op === "update")) {
          updates.push(calls.find((c) => c.op === "update")!.args[0]);
          // The first write loses the race: no row matched the old notes.
          return { data: updates.length === 1 ? [] : [{ id: "crm-1" }], error: null };
        }
        reads++;
        return { data: { id: "crm-1", name: "Ana", phone: null, notes: reads === 1 ? null : other }, error: null };
      });

      await crm.attachPhone("crm-1", "5511988887777");

      expect(updates).toEqual([
        { notes: "Outro WhatsApp (não verificado): 5511988887777" },
        { notes: `${other}
Outro WhatsApp (não verificado): 5511988887777` },
      ]);
    });

    it("gives up after repeated races so the job can retry later (M12)", async () => {
      const { crm } = crmWith((calls) =>
        calls.some((c) => c.op === "update")
          ? { data: [], error: null }
          : { data: { id: "crm-1", name: "Ana", phone: null, notes: null }, error: null },
      );

      await expect(crm.attachPhone("crm-1", "5511988887777")).rejects.toThrow(/notes/);
    });

    it("does nothing when the phone is already the client's", async () => {
      const { crm, updates } = attachScenario({ phone: "+55 11 98888-7777", notes: null });
      await crm.attachPhone("crm-1", "5511988887777");
      expect(updates).toEqual([]);
    });
  });
});

const VERIFIED: CrmScope = { clientId: "crm-1", verified: true, conversationId: "conv-1" };
const UNVERIFIED: CrmScope = { clientId: "crm-1", verified: false, conversationId: "conv-1" };

function crmWithTables(handlers: Record<string, Handler>) {
  const supabase = createSupabaseMock(handlers);
  return { crm: createSupabaseCrm(supabase as never, { agentUserId: AGENT_USER }), supabase };
}

const isUpdate = (calls: TableCall) => calls.some((c) => c.op === "update");
const updateOf = (calls: TableCall) => calls.find((c) => c.op === "update")!.args[0];
const guardsOf = (calls: TableCall) => calls.filter((c) => c.op === "eq");

/** A table whose reads return `rows` in turn (last one repeats) and whose updates return `writes` in turn. */
function rowTable(rows: unknown[], writes: unknown[][] = [[{ id: "row" }]]) {
  const updates: TableCall[] = [];
  let reads = 0;
  const handler: Handler = (calls) => {
    if (isUpdate(calls)) {
      updates.push(calls);
      return { data: writes[Math.min(updates.length - 1, writes.length - 1)], error: null };
    }
    const row = rows[Math.min(reads, rows.length - 1)];
    reads++;
    return { data: row, error: null };
  };
  return { handler, updates, reads: () => reads };
}

const CLIENT_ROW = {
  id: "crm-1",
  email: null,
  landline: "1133334444",
  birthday: null,
  lead_source: "instagram",
  referred_by: null,
  company: "",
  notes: null,
  updated_at: "2026-11-01T10:00:00Z",
};

describe("CRM records", () => {
  describe("loadSnapshot", () => {
    it("verified: lists missing client fields, vessels and open deals", async () => {
      const recorded: Record<string, TableCall> = {};
      const { crm } = crmWithTables({
        clients: (calls) => ((recorded.clients = calls), { data: CLIENT_ROW, error: null }),
        vessels: (calls) => (
          (recorded.vessels = calls),
          { data: [{ id: "v1", kind: "jet_ski", brand: "sea_doo", model: "GTI", year: 2020 }], error: null }
        ),
        deals: (calls) => (
          (recorded.deals = calls),
          {
            data: [
              { id: "d1", pipeline: "vendas", stage: "proposta", title: "Lancha 26" },
              { id: "d2", pipeline: "vendas", stage: "fechado", title: "Antigo" },
              { id: "d3", pipeline: "manutencao", stage: "entregue", title: "Revisão" },
            ],
            error: null,
          }
        ),
      });

      await expect(crm.loadSnapshot(VERIFIED)).resolves.toEqual({
        missingClientFields: ["email", "birthday", "company"],
        vessels: [{ id: "v1", kind: "jet_ski", summary: "Jet Ski · Sea-Doo GTI · 2020" }],
        openDeals: [
          { id: "d1", pipeline: "vendas", stageLabel: "Proposta", title: "Lancha 26" },
          { id: "d3", pipeline: "manutencao", stageLabel: "Entregue", title: "Revisão" },
        ],
      });
      expect(recorded.clients).toContainEqual({ op: "eq", args: ["id", "crm-1"] });
      for (const table of ["vessels", "deals"]) {
        expect(recorded[table]).toContainEqual({ op: "eq", args: ["client_id", "crm-1"] });
        expect(recorded[table]).toContainEqual({ op: "limit", args: [20] });
        expect(recorded[table].map((c) => c.args[0])).not.toContain("created_by_conversation");
      }
    });

    it("verified: asks who referred only when the lead came by referral", async () => {
      const { crm } = crmWithTables({
        clients: () => ({
          data: { ...CLIENT_ROW, email: "a@b.com", company: "X", birthday: "1980-01-01", lead_source: "indicacao" },
          error: null,
        }),
        vessels: () => ({ data: [], error: null }),
        deals: () => ({ data: [], error: null }),
      });
      await expect(crm.loadSnapshot(VERIFIED)).resolves.toMatchObject({ missingClientFields: ["referred_by"] });
    });

    it("unverified: reads only what this conversation created", async () => {
      const recorded: Record<string, TableCall> = {};
      const { crm, supabase } = crmWithTables({
        clients: () => ({ data: CLIENT_ROW, error: null }),
        vessels: (calls) => ((recorded.vessels = calls), { data: [], error: null }),
        deals: (calls) => ((recorded.deals = calls), { data: [], error: null }),
      });

      await expect(crm.loadSnapshot(UNVERIFIED)).resolves.toEqual({ missingClientFields: [], vessels: [], openDeals: [] });
      expect(supabase.from).not.toHaveBeenCalledWith("clients");
      for (const table of ["vessels", "deals"]) {
        expect(recorded[table]).toContainEqual({ op: "eq", args: ["client_id", "crm-1"] });
        expect(recorded[table]).toContainEqual({ op: "eq", args: ["created_by_conversation", "conv-1"] });
      }
    });
  });

  describe("fillClient", () => {
    it("writes only empty fields guarded by updated_at", async () => {
      const t = rowTable([{ ...CLIENT_ROW, company: "ACME" }]);
      const { crm } = crmWithTables({ clients: t.handler });

      await expect(crm.fillClient(VERIFIED, { email: "a@b.com", company: "acme" })).resolves.toEqual({
        filled: ["email"],
        conflicts: [],
      });
      expect(t.updates.map(updateOf)).toEqual([{ email: "a@b.com" }]);
      expect(guardsOf(t.updates[0])).toEqual([
        { op: "eq", args: ["id", "crm-1"] },
        { op: "eq", args: ["updated_at", "2026-11-01T10:00:00Z"] },
      ]);
      expect(t.updates[0]).toContainEqual({ op: "select", args: ["id"] });
    });

    it("notes a different value instead of overwriting", async () => {
      const t = rowTable([{ ...CLIENT_ROW, email: "x@y.com", notes: "VIP" }]);
      const { crm } = crmWithTables({ clients: t.handler });

      await expect(crm.fillClient(VERIFIED, { email: "a@b.com" })).resolves.toEqual({ filled: [], conflicts: ["email"] });
      expect(t.updates.map(updateOf)).toEqual([{ notes: "VIP\nCliente informou E-mail diferente: a@b.com" }]);
    });

    it("does not write when nothing changes", async () => {
      const t = rowTable([{ ...CLIENT_ROW, email: "a@b.com" }]);
      const { crm } = crmWithTables({ clients: t.handler });
      await expect(crm.fillClient(VERIFIED, { email: "A@B.com" })).resolves.toEqual({ filled: [], conflicts: [] });
      expect(t.updates).toEqual([]);
    });

    it("retries when updated_at changed", async () => {
      const t = rowTable(
        [CLIENT_ROW, { ...CLIENT_ROW, company: "Equipe", updated_at: "2026-11-01T10:05:00Z" }],
        [[], [{ id: "crm-1" }]],
      );
      const { crm } = crmWithTables({ clients: t.handler });

      await expect(crm.fillClient(VERIFIED, { email: "a@b.com", company: "Outra" })).resolves.toEqual({
        filled: ["email"],
        conflicts: ["company"],
      });
      expect(t.reads()).toBe(2);
      expect(t.updates.map(updateOf)).toEqual([
        { email: "a@b.com", company: "Outra" },
        { email: "a@b.com", notes: "Cliente informou Empresa diferente: Outra" },
      ]);
      expect(guardsOf(t.updates[1])).toContainEqual({ op: "eq", args: ["updated_at", "2026-11-01T10:05:00Z"] });
    });

    it("gives up after 3 attempts", async () => {
      const t = rowTable([CLIENT_ROW], [[]]);
      const { crm } = crmWithTables({ clients: t.handler });
      await expect(crm.fillClient(VERIFIED, { email: "a@b.com" })).rejects.toThrow(
        "CRM clients crm-1: kept changing; not filled",
      );
      expect(t.updates).toHaveLength(3);
    });

    it("refuses an unverified scope", async () => {
      const { crm, supabase } = crmWithTables({ clients: () => ({ data: CLIENT_ROW, error: null }) });
      await expect(crm.fillClient(UNVERIFIED, { email: "a@b.com" })).rejects.toBeInstanceOf(CrmNotInScopeError);
      expect(supabase.from).not.toHaveBeenCalled();
    });

    it("drops keys that are not client fields", async () => {
      const t = rowTable([CLIENT_ROW]);
      const { crm } = crmWithTables({ clients: t.handler });

      await crm.fillClient(VERIFIED, { notes: "x", user_id: "y" } as never);
      expect(t.updates).toEqual([]);

      await crm.fillClient(VERIFIED, { email: "a@b.com", notes: "x", user_id: "y", cpf: "1" } as never);
      expect(t.updates.map(updateOf)).toEqual([{ email: "a@b.com" }]);
    });
  });

  describe("scope of vessels and deals", () => {
    const outside = [
      { name: "another client's record", scope: VERIFIED, row: { client_id: "crm-2", created_by_conversation: null } },
      {
        name: "an unverified link and another conversation",
        scope: UNVERIFIED,
        row: { client_id: "crm-1", created_by_conversation: "conv-2" },
      },
      { name: "an unverified link and a staff record", scope: UNVERIFIED, row: { client_id: "crm-1", created_by_conversation: null } },
    ];

    for (const { name, scope, row } of outside) {
      it(`fillVessel refuses a record outside the scope: ${name}`, async () => {
        const t = rowTable([{ id: "v-secret", kind: "motor_popa", brand: "mercury", notes: "segredo", updated_at: "t1", ...row }]);
        const { crm } = crmWithTables({ vessels: t.handler });

        const error = await crm.fillVessel(scope, "v-secret", { horsepower: 150 }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CrmNotInScopeError);
        expect((error as Error).name).toBe("CrmNotInScopeError");
        expect((error as Error).message).toBe("CRM record not in scope");
        expect(t.updates).toEqual([]);
      });

      it(`fillDeal refuses a record outside the scope: ${name}`, async () => {
        const t = rowTable([{ id: "d-secret", pipeline: "vendas", brand: "Fishing", notes: "segredo", updated_at: "t1", ...row }]);
        const { crm } = crmWithTables({ deals: t.handler });

        const error = await crm.fillDeal(scope, "d-secret", { model: "26" }).catch((e: unknown) => e);
        expect(error).toBeInstanceOf(CrmNotInScopeError);
        expect((error as Error).message).toBe("CRM record not in scope");
        expect(t.updates).toEqual([]);
      });
    }

    it("treats a missing record like one outside the scope", async () => {
      const { crm } = crmWithTables({ vessels: () => ({ data: null, error: null }), deals: () => ({ data: null, error: null }) });
      await expect(crm.fillVessel(VERIFIED, "nope", { year: 2020 })).rejects.toBeInstanceOf(CrmNotInScopeError);
      await expect(crm.fillDeal(VERIFIED, "nope", { model: "x" })).rejects.toBeInstanceOf(CrmNotInScopeError);
    });

    it("fillVessel completes a vessel this conversation created and returns its kind", async () => {
      const t = rowTable([
        {
          id: "v1",
          client_id: "crm-1",
          created_by_conversation: "conv-1",
          kind: "motor_popa",
          brand: "mercury",
          horsepower: null,
          notes: null,
          updated_at: "t1",
        },
      ]);
      const { crm } = crmWithTables({ vessels: t.handler });

      await expect(crm.fillVessel(UNVERIFIED, "v1", { horsepower: 150, brand: "mercury" })).resolves.toEqual({
        filled: ["horsepower"],
        conflicts: [],
        kind: "motor_popa",
      });
      expect(t.updates.map(updateOf)).toEqual([{ horsepower: 150 }]);
      expect(guardsOf(t.updates[0])).toEqual([
        { op: "eq", args: ["id", "v1"] },
        { op: "eq", args: ["updated_at", "t1"] },
      ]);
    });

    it("fillVessel drops keys that are not vessel fields", async () => {
      const t = rowTable([{ id: "v1", client_id: "crm-1", created_by_conversation: null, kind: "jet_ski", notes: null, updated_at: "t1" }]);
      const { crm } = crmWithTables({ vessels: t.handler });
      await crm.fillVessel(VERIFIED, "v1", { client_id: "crm-2", notes: "x", model: "GTI" } as never);
      expect(t.updates.map(updateOf)).toEqual([{ model: "GTI" }]);
    });
  });

  describe("fillDeal", () => {
    const DEAL = {
      id: "d1",
      client_id: "crm-1",
      created_by_conversation: null,
      pipeline: "vendas",
      brand: null,
      notes: null,
      updated_at: "t1",
    };

    it("drops fields that are not the agent's for the deal's pipeline", async () => {
      const t = rowTable([DEAL]);
      const { crm } = crmWithTables({ deals: t.handler });

      await expect(
        crm.fillDeal(VERIFIED, "d1", { consortium_value: 1, olist_proposal_number: "x" } as never),
      ).resolves.toEqual({ filled: [], conflicts: [] });
      expect(t.updates).toEqual([]);
      // administrator is an agent field, but of consorcios, not vendas.
      await crm.fillDeal(VERIFIED, "d1", { brand: "Fishing", administrator: "Itaú" });
      expect(t.updates.map(updateOf)).toEqual([{ brand: "Fishing" }]);
    });

    it("refuses a vessel_id outside the scope", async () => {
      const t = rowTable([{ ...DEAL, pipeline: "manutencao", vessel_id: null, service_description: null }]);
      const { crm } = crmWithTables({
        deals: t.handler,
        vessels: () => ({ data: { id: "v9", client_id: "crm-2", created_by_conversation: null }, error: null }),
      });

      await expect(crm.fillDeal(VERIFIED, "d1", { vessel_id: "v9" })).rejects.toBeInstanceOf(CrmNotInScopeError);
      expect(t.updates).toEqual([]);
    });

    it("links a vessel in the scope", async () => {
      const t = rowTable([{ ...DEAL, pipeline: "manutencao", vessel_id: null, service_description: null }]);
      const { crm } = crmWithTables({
        deals: t.handler,
        vessels: () => ({ data: { id: "v1", client_id: "crm-1", created_by_conversation: null }, error: null }),
      });

      await expect(crm.fillDeal(VERIFIED, "d1", { vessel_id: "v1", service_description: "Revisão" })).resolves.toEqual({
        filled: ["vessel_id", "service_description"],
        conflicts: [],
      });
    });
  });

  describe("createVessel", () => {
    it("stamps the conversation only on an unverified link", async () => {
      const inserts: unknown[] = [];
      const { crm } = crmWithTables({
        vessels: (calls) => {
          inserts.push(calls.find((c) => c.op === "insert")!.args[0]);
          return { data: { id: "v-new" }, error: null };
        },
      });

      await expect(
        crm.createVessel(VERIFIED, "jet_ski", { brand: "sea_doo", notes: "x", user_id: "z" } as never),
      ).resolves.toEqual({ id: "v-new" });
      await crm.createVessel(UNVERIFIED, "motor_popa", { brand: "mercury", horsepower: 150 });

      expect(inserts).toEqual([
        {
          user_id: AGENT_USER,
          client_id: "crm-1",
          kind: "jet_ski",
          brand: "sea_doo",
          notes: "x",
          created_by_conversation: null,
        },
        {
          user_id: AGENT_USER,
          client_id: "crm-1",
          kind: "motor_popa",
          brand: "mercury",
          horsepower: 150,
          created_by_conversation: "conv-1",
        },
      ]);
    });
  });

  describe("createDeal", () => {
    it("calls agent_create_deal with the agent user", async () => {
      const { crm, supabase } = crmWithTables({ "rpc:agent_create_deal": () => ({ data: "deal-9", error: null }) });

      await expect(
        crm.createDeal(VERIFIED, "vendas", "Lancha 26", {
          brand: "Fishing",
          consortium_value: 1,
          olist_proposal_number: "x",
        } as never),
      ).resolves.toEqual({ id: "deal-9" });
      await crm.createDeal(UNVERIFIED, "pecas", "Hélice", { part_description: "Hélice 15x17" });

      expect(supabase.rpc.mock.calls).toEqual([
        [
          "agent_create_deal",
          {
            p_user_id: AGENT_USER,
            p_client_id: "crm-1",
            p_pipeline: "vendas",
            p_title: "Lancha 26",
            p_fields: { brand: "Fishing" },
            p_conversation_id: null,
          },
        ],
        [
          "agent_create_deal",
          {
            p_user_id: AGENT_USER,
            p_client_id: "crm-1",
            p_pipeline: "pecas",
            p_title: "Hélice",
            p_fields: { part_description: "Hélice 15x17" },
            p_conversation_id: "conv-1",
          },
        ],
      ]);
    });

    it("refuses a vessel_id outside the scope", async () => {
      const { crm, supabase } = crmWithTables({
        vessels: () => ({ data: { id: "v9", client_id: "crm-2", created_by_conversation: null }, error: null }),
        "rpc:agent_create_deal": () => ({ data: "deal-9", error: null }),
      });

      await expect(crm.createDeal(VERIFIED, "manutencao", "Revisão", { vessel_id: "v9" })).rejects.toBeInstanceOf(
        CrmNotInScopeError,
      );
      expect(supabase.rpc).not.toHaveBeenCalled();
    });

    it("refuses a staff vessel on an unverified link", async () => {
      const { crm, supabase } = crmWithTables({
        vessels: () => ({ data: { id: "v9", client_id: "crm-1", created_by_conversation: null }, error: null }),
      });
      await expect(crm.createDeal(UNVERIFIED, "manutencao", "Revisão", { vessel_id: "v9" })).rejects.toBeInstanceOf(
        CrmNotInScopeError,
      );
      expect(supabase.rpc).not.toHaveBeenCalled();
    });
  });

  describe("findOpenDeal", () => {
    it("skips deals in the last stage", async () => {
      let recorded: TableCall = [];
      const { crm } = crmWithTables({ deals: (calls) => ((recorded = calls), { data: [{ id: "d1" }], error: null }) });

      await expect(crm.findOpenDeal(VERIFIED, "vendas")).resolves.toEqual({ id: "d1" });
      expect(recorded).toContainEqual({ op: "eq", args: ["client_id", "crm-1"] });
      expect(recorded).toContainEqual({ op: "eq", args: ["pipeline", "vendas"] });
      expect(recorded).toContainEqual({ op: "neq", args: ["stage", "fechado"] });
      expect(recorded).toContainEqual({ op: "order", args: ["updated_at", { ascending: false }] });
      expect(recorded).toContainEqual({ op: "limit", args: [1] });
      expect(recorded.map((c) => c.args[0])).not.toContain("created_by_conversation");
    });

    it("only sees this conversation's deals on an unverified link", async () => {
      let recorded: TableCall = [];
      const { crm } = crmWithTables({ deals: (calls) => ((recorded = calls), { data: [], error: null }) });

      await expect(crm.findOpenDeal(UNVERIFIED, "manutencao")).resolves.toBeNull();
      expect(recorded).toContainEqual({ op: "neq", args: ["stage", "pago"] });
      expect(recorded).toContainEqual({ op: "eq", args: ["created_by_conversation", "conv-1"] });
    });
  });
});
