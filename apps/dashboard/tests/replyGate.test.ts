import { describe, expect, it } from "vitest";
import { replyGate } from "../lib/replyGate";

describe("replyGate", () => {
  it("open conversations are read-only", () => {
    expect(replyGate({ status: "open", assignedTo: null }, "me")).toBe("read-only");
  });
  it("unassigned handoff asks to assume first", () => {
    expect(replyGate({ status: "awaiting_human", assignedTo: null }, "me")).toBe("assume-first");
  });
  it("someone else's handoff warns", () => {
    expect(replyGate({ status: "awaiting_human", assignedTo: { id: "other" } }, "me")).toBe("warn-other-owner");
  });
  it("my handoff is ok", () => {
    expect(replyGate({ status: "awaiting_human", assignedTo: { id: "me" } }, "me")).toBe("ok");
  });
});
