import type { ModelProvider, ProviderRuntimeConfig } from "./types.js";
import { createAnthropicProvider } from "./providers/anthropic.js";
import { createGeminiProvider } from "./providers/gemini.js";
import { createOpenAICompatibleProvider } from "./providers/openai-compatible.js";
import { createOpenAIProvider } from "./providers/openai.js";

export interface ProviderFactory {
  create(config: ProviderRuntimeConfig): ModelProvider;
}

export class DefaultProviderFactory implements ProviderFactory {
  create(config: ProviderRuntimeConfig): ModelProvider {
    switch (config.kind) {
      case "openai":
        return createOpenAIProvider(config.apiKey, config.baseUrl);
      case "openai_compatible":
        if (!config.baseUrl) throw new Error("OpenAI-compatible provider requires a base URL");
        return createOpenAICompatibleProvider(config.apiKey, config.baseUrl);
      case "anthropic":
        return createAnthropicProvider(config.apiKey, config.baseUrl);
      case "gemini":
        return createGeminiProvider(config.apiKey);
    }
  }
}
