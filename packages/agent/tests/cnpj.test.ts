import { describe, expect, it } from "vitest";
import { isValidCnpj, isValidCpfOrCnpj } from "../src/cnpj";

describe("isValidCnpj", () => {
  it.each([
    ["11.222.333/0001-81", true],
    ["11222333000181", true],
    ["11.222.333/0001-82", false],
    ["00000000000000", false],
    ["1122233300018", false],
  ])("%s -> %s", (input, expected) => {
    expect(isValidCnpj(input)).toBe(expected);
  });
});

describe("isValidCpfOrCnpj", () => {
  it("accepts a valid CPF", () => expect(isValidCpfOrCnpj("529.982.247-25")).toBe(true));
  it("accepts a valid CNPJ", () => expect(isValidCpfOrCnpj("11.222.333/0001-81")).toBe(true));
  it("rejects garbage", () => expect(isValidCpfOrCnpj("123")).toBe(false));
});
