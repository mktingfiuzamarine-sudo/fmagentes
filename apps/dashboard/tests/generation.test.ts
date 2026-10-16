import { describe, expect, it } from "vitest";
import { createGeneration } from "../lib/generation";

describe("createGeneration (M13)", () => {
  it("lets only the latest generation's answer through", () => {
    const generation = createGeneration();
    const oldTab = generation.current();
    generation.advance();
    const newTab = generation.current();

    expect(generation.isCurrent(oldTab)).toBe(false);
    expect(generation.isCurrent(newTab)).toBe(true);
  });
});
