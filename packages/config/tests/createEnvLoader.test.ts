import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createEnvLoader } from "../src/createEnvLoader";

describe("createEnvLoader", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("returns parsed env when valid", () => {
    process.env.FOO = "bar";
    const schema = z.object({ FOO: z.string() });
    const loadEnv = createEnvLoader(schema);

    expect(loadEnv()).toEqual({ FOO: "bar" });
  });

  it("exits the process with a clear message when required vars are missing", () => {
    delete process.env.FOO;
    const schema = z.object({ FOO: z.string() });
    const loadEnv = createEnvLoader(schema);

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() => loadEnv()).toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("FOO"));
  });
});
