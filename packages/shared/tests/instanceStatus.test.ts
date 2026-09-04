import { describe, expect, it } from "vitest";
import { INSTANCE_STATUS, mapConnectionState } from "../src/instanceStatus";

describe("mapConnectionState", () => {
  it("maps open to connected", () => {
    expect(mapConnectionState("open")).toBe(INSTANCE_STATUS.CONNECTED);
  });
  it("maps connecting to connecting", () => {
    expect(mapConnectionState("connecting")).toBe(INSTANCE_STATUS.CONNECTING);
  });
  it("maps close and anything else to disconnected", () => {
    expect(mapConnectionState("close")).toBe(INSTANCE_STATUS.DISCONNECTED);
    expect(mapConnectionState("weird")).toBe(INSTANCE_STATUS.DISCONNECTED);
  });
});
