import { describe, expect, it } from "vitest";
import { phoneMatchSuffixes } from "../src/crm/phoneMatch";

describe("phoneMatchSuffixes", () => {
  it("strips 55 and adds the variant without the ninth digit", () => {
    expect(phoneMatchSuffixes("5511999998888")).toEqual(["11999998888", "1199998888"]);
  });

  it("adds the ninth digit to an old 8-digit mobile", () => {
    expect(phoneMatchSuffixes("551199998888")).toEqual(["1199998888", "11999998888"]);
  });

  it("does not invent a variant when the 11-digit number's third digit is not 9", () => {
    expect(phoneMatchSuffixes("5511333334444")).toEqual(["11333334444"]);
  });

  it("keeps a foreign number whole", () => {
    expect(phoneMatchSuffixes("14155552671")).toEqual(["14155552671"]);
  });

  it("refuses numbers too short to match safely", () => {
    expect(phoneMatchSuffixes("55999988")).toEqual([]);
    expect(phoneMatchSuffixes("12345")).toEqual([]);
    expect(phoneMatchSuffixes("")).toEqual([]);
  });

  it("ignores formatting", () => {
    expect(phoneMatchSuffixes("+55 (11) 99999-8888")).toEqual(["11999998888", "1199998888"]);
  });
});
