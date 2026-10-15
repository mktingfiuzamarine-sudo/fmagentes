import { describe, expect, it } from "vitest";
import { formatPhone, formatTabTitle, formatRelative } from "../lib/format";

describe("formatPhone", () => {
  it("formats Brazilian mobile and landline numbers with country code", () => {
    expect(formatPhone("5511900000002")).toBe("+55 (11) 90000-0002");
    expect(formatPhone("551133334444")).toBe("+55 (11) 3333-4444");
  });
  it("leaves anything else as digits", () => {
    expect(formatPhone("12025550123")).toBe("12025550123");
  });
});

describe("formatRelative", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  it("buckets elapsed time", () => {
    expect(formatRelative("2026-10-15T11:59:40Z", now)).toBe("agora");
    expect(formatRelative("2026-10-15T11:55:00Z", now)).toBe("5 min");
    expect(formatRelative("2026-10-15T09:00:00Z", now)).toBe("3 h");
    expect(formatRelative("2026-10-13T12:00:00Z", now)).toBe("2 d");
  });
  it("treats future timestamps (clock skew) as now", () => {
    expect(formatRelative("2026-10-15T12:00:30Z", now)).toBe("agora");
  });
});

describe("formatTabTitle", () => {
  it("prefixes the handoff count only when positive", () => {
    expect(formatTabTitle(3)).toBe("(3) fmagentes");
    expect(formatTabTitle(0)).toBe("fmagentes");
  });
});
