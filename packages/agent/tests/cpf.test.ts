import { describe, expect, it } from "vitest";
import { isValidCpf, normalizeCpf } from "../src/cpf";

describe("normalizeCpf", () => {
  it("keeps digits only", () => {
    expect(normalizeCpf(" 529.982.247-25 ")).toBe("52998224725");
  });
});

describe("isValidCpf", () => {
  it.each(["52998224725", "529.982.247-25", "111.444.777-35", "111 444 777 35"])("accepts %s", (cpf) => {
    expect(isValidCpf(cpf)).toBe(true);
  });

  it.each([
    ["wrong first check digit", "52998224715"],
    ["wrong second check digit", "52998224726"],
    ["repeated digits", "111.111.111-11"],
    ["too short", "5299822472"],
    ["too long", "529982247250"],
    ["empty", ""],
    ["letters", "abc.def.ghi-jk"],
  ])("rejects %s", (_label, cpf) => {
    expect(isValidCpf(cpf)).toBe(false);
  });
});
