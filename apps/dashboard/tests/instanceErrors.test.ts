import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import { createInstanceErrorMessage } from "../lib/instanceErrors";

describe("createInstanceErrorMessage (M3)", () => {
  it("explains each refusal the API can give", () => {
    expect(createInstanceErrorMessage(new ApiError(400, {}))).toMatch(/letras, números/);
    expect(createInstanceErrorMessage(new ApiError(409, {}))).toMatch(/já está em uso/);
    expect(createInstanceErrorMessage(new ApiError(502, {}))).toBe("A Evolution API não respondeu.");
  });

  it("falls back to a generic message", () => {
    expect(createInstanceErrorMessage(new ApiError(500, {}))).toBe("Não foi possível criar o número.");
    expect(createInstanceErrorMessage(new Error("network"))).toBe("Não foi possível criar o número.");
  });
});
