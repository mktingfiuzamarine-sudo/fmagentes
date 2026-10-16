import { describe, expect, it } from "vitest";
import { parseTrustProxy } from "../src/env";

describe("parseTrustProxy", () => {
  it("trusts nothing when unset", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
  });

  it("reads booleans, a hop count, or a list of proxy addresses", () => {
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("10.0.0.0/8, 172.16.0.0/12")).toBe("10.0.0.0/8, 172.16.0.0/12");
  });
});
