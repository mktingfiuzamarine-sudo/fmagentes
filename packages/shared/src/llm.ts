import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

export type LlmProvider = "anthropic" | "openai";

export interface LlmConfig {
  anthropicApiKey: string;
  openaiApiKey: string;
}

export interface ModelOptions {
  /** Anthropic only: honour cacheControl metadata on prompt messages. */
  cacheControl?: boolean;
}

export function getModel(
  config: LlmConfig,
  provider: LlmProvider,
  modelName: string,
  options: ModelOptions = {},
): LanguageModel {
  switch (provider) {
    case "anthropic":
      return createAnthropic({ apiKey: config.anthropicApiKey })(modelName, {
        cacheControl: options.cacheControl ?? false,
      });
    case "openai":
      return createOpenAI({ apiKey: config.openaiApiKey })(modelName);
    default: {
      const exhaustiveCheck: never = provider;
      throw new Error(`Unsupported LLM provider: ${exhaustiveCheck}`);
    }
  }
}
