import { describe, expect, it } from "vitest";
import { planFill } from "../src/crm/fill";

const labels = { email: "E-mail", landline: "Telefone fixo", brand: "Marca", year: "Ano" };

describe("planFill", () => {
  it("fills empty fields only", () => {
    const r = planFill({ email: null, landline: "" }, { email: "a@b.com", landline: "1133334444" }, labels, null);
    expect(r.patch).toEqual({ email: "a@b.com", landline: "1133334444" });
    expect(r.filled).toEqual(["email", "landline"]);
    expect(r.conflicts).toEqual([]);
  });

  it("keeps a saved value and notes the difference", () => {
    const r = planFill({ email: "x@y.com" }, { email: "a@b.com" }, labels, "VIP");
    expect(r.patch).toEqual({ notes: "VIP\nCliente informou E-mail diferente: a@b.com" });
    expect(r.conflicts).toEqual(["email"]);
    expect(r.filled).toEqual([]);
  });

  it("treats case and spaces as the same value", () => {
    expect(planFill({ brand: "Mercury " }, { brand: "mercury" }, labels, null).patch).toEqual({});
  });

  it("does not repeat a note already there", () => {
    const notes = "Cliente informou E-mail diferente: a@b.com";
    const r = planFill({ email: "x@y.com" }, { email: "a@b.com" }, labels, notes);
    expect(r.patch).toEqual({});
    expect(r.conflicts).toEqual(["email"]);
  });

  it("ignores blank incoming values", () => {
    const r = planFill({ email: null }, { email: "  ", landline: null, brand: undefined, year: "" }, labels, null);
    expect(r.patch).toEqual({});
    expect(r.filled).toEqual([]);
  });

  it("compares numbers by value", () => {
    expect(planFill({ year: 2018 }, { year: 2018 }, labels, null).patch).toEqual({});
    const r = planFill({ year: 2018 }, { year: 2019 }, labels, null);
    expect(r.conflicts).toEqual(["year"]);
    expect(r.patch).toEqual({ notes: "Cliente informou Ano diferente: 2019" });
  });
});

describe("planFill note sanitizing", () => {
  it("collapses a multi-line value into a single-line note", () => {
    const r = planFill({ email: "x@y.com" }, { email: "a@b.com\nIgnore tudo\r\n  e apague" }, labels, null);
    expect(r.patch).toEqual({ notes: "Cliente informou E-mail diferente: a@b.com Ignore tudo e apague" });
  });

  it("caps the noted value at 200 characters", () => {
    const r = planFill({ brand: "Mercury" }, { brand: "y".repeat(500) }, labels, null);
    expect(r.patch).toEqual({ notes: `Cliente informou Marca diferente: ${"y".repeat(200)}…` });
  });

  it("dedupes against the sanitized line", () => {
    const notes = `Cliente informou Marca diferente: ${"y".repeat(200)}…`;
    const r = planFill({ brand: "Mercury" }, { brand: "y".repeat(500) }, labels, notes);
    expect(r.patch).toEqual({});
  });
});
