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

  it("does not strip a 9 when what remains is landline-shaped", () => {
    // 33334444 is a landline local number: 1133334444 may be someone else.
    expect(phoneMatchSuffixes("5511933334444")).toEqual(["11933334444"]);
  });

  it("does not add a 9 to a landline", () => {
    expect(phoneMatchSuffixes("551133334444")).toEqual(["1133334444"]);
  });

  it("treats local numbers starting 6 to 9 as mobile", () => {
    expect(phoneMatchSuffixes("5511966665555")).toEqual(["11966665555", "1166665555"]);
    expect(phoneMatchSuffixes("551177776666")).toEqual(["1177776666", "11977776666"]);
    expect(phoneMatchSuffixes("551155554444")).toEqual(["1155554444"]);
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
