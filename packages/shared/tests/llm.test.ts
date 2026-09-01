import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@ai-sdk/anthropic");
vi.mock("@ai-sdk/openai");

import { getModel } from "../src/llm";
import * as anthropicModule from "@ai-sdk/anthropic";
import * as openaiModule from "@ai-sdk/openai";

const config = { anthropicApiKey: "a-key", openaiApiKey: "o-key" };

describe("getModel", () => {
  let anthropicModelFactory: ReturnType<typeof vi.fn>;
  let createAnthropicMock: ReturnType<typeof vi.fn>;
  let openaiModelFactory: ReturnType<typeof vi.fn>;
  let createOpenAIMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    anthropicModelFactory = vi.fn(() => "anthropic-model");
    createAnthropicMock = vi.fn(() => anthropicModelFactory);
    openaiModelFactory = vi.fn(() => "openai-model");
    createOpenAIMock = vi.fn(() => openaiModelFactory);

    vi.mocked(anthropicModule.createAnthropic).mockImplementation(createAnthropicMock);
    vi.mocked(openaiModule.createOpenAI).mockImplementation(createOpenAIMock);
  });

  it("returns an Anthropic model when provider is anthropic", () => {
    const model = getModel(config, "anthropic", "claude-opus-4-8");

    expect(createAnthropicMock).toHaveBeenCalledWith({ apiKey: "a-key" });
    expect(anthropicModelFactory).toHaveBeenCalledWith("claude-opus-4-8");
    expect(model).toBe("anthropic-model");
  });

  it("returns an OpenAI model when provider is openai", () => {
    const model = getModel(config, "openai", "gpt-4o");

    expect(createOpenAIMock).toHaveBeenCalledWith({ apiKey: "o-key" });
    expect(openaiModelFactory).toHaveBeenCalledWith("gpt-4o");
    expect(model).toBe("openai-model");
  });
});
