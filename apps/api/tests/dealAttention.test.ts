import { describe, expect, it } from "vitest";
import { createSupabaseDealAttention } from "../src/dashboard/dealAttention";
import { createSupabaseMock, type TableCall } from "./helpers/supabaseMock";

function attentionWith(error: unknown = null) {
  const calls: TableCall[] = [];
  const supabase = createSupabaseMock({ deals: (c) => (calls.push(c), { data: null, error }) });
  return { port: createSupabaseDealAttention(supabase as never), calls };
}
const updateOf = (calls: TableCall) => calls.find((c) => c.op === "update")!.args[0];

describe("createSupabaseDealAttention", () => {
  it("setInService writes the attendant name and the time", async () => {
    const { port, calls } = attentionWith();
    await port.setInService("d-1", "Ana");
    expect(updateOf(calls[0])).toEqual({ attention: "in_service", attention_since: expect.any(String), attention_by: "Ana" });
    expect(calls[0]).toContainEqual({ op: "eq", args: ["id", "d-1"] });
  });

  it("setWaiting goes back to waiting without a name", async () => {
    const { port, calls } = attentionWith();
    await port.setWaiting("d-1");
    expect(updateOf(calls[0])).toEqual({ attention: "waiting", attention_since: expect.any(String), attention_by: null });
  });

  it("clear empties every attention column", async () => {
    const { port, calls } = attentionWith();
    await port.clear("d-1");
    expect(updateOf(calls[0])).toEqual({ attention: null, attention_since: null, attention_by: null });
  });

  it("throws when the CRM write fails", async () => {
    const { port } = attentionWith({ message: "boom" });
    await expect(port.setWaiting("d-1")).rejects.toThrow();
  });
});
