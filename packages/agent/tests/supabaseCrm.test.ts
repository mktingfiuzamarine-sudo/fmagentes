import { describe, expect, it, vi } from "vitest";
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
