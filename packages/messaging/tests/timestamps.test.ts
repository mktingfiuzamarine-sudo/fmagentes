import { describe, expect, it } from "vitest";
import { laterTimestamp } from "../src/internal/timestamps";

describe("laterTimestamp", () => {
  it("returns the later of two timestamps", () => {
    expect(laterTimestamp("2026-10-14T12:00:00Z", "2026-10-14T12:00:01Z")).toBe("2026-10-14T12:00:01Z");
    expect(laterTimestamp("2026-10-14T12:00:01Z", "2026-10-14T12:00:00Z")).toBe("2026-10-14T12:00:01Z");
  });

  it("tells apart Postgres microseconds that Date.parse truncates", () => {
    expect(laterTimestamp("2026-10-14T12:00:00.123456+00:00", "2026-10-14T12:00:00.123+00:00")).toBe(
      "2026-10-14T12:00:00.123456+00:00",
    );
    expect(laterTimestamp("2026-10-14T12:00:00.1234+00:00", "2026-10-14T12:00:00.123456+00:00")).toBe(
      "2026-10-14T12:00:00.123456+00:00",
    );
  });

  it("compares across time zone offsets", () => {
    expect(laterTimestamp("2026-10-14T09:00:01-03:00", "2026-10-14T12:00:00Z")).toBe("2026-10-14T09:00:01-03:00");
  });

  it("ignores a missing side", () => {
    expect(laterTimestamp(null, "2026-10-14T12:00:00Z")).toBe("2026-10-14T12:00:00Z");
    expect(laterTimestamp("2026-10-14T12:00:00Z", null)).toBe("2026-10-14T12:00:00Z");
  });
});
