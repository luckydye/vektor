import type { AIChatAppProvider, Provider } from "../types.ts";
import { ollamaProvider } from "./ollamaProvider.ts";
import { opencodeProvider } from "./opencodeProvider.ts";
import { openrouterProvider } from "./openrouterProvider.ts";

export const AI_CHAT_PROVIDERS = [
  openrouterProvider,
  opencodeProvider,
  ollamaProvider,
] satisfies AIChatAppProvider[];

export function getAIChatProvider(provider: Provider): AIChatAppProvider {
  const match = AI_CHAT_PROVIDERS.find((entry) => entry.option.value === provider);
  if (!match) {
    throw new Error(`Unsupported AI chat provider: ${provider}`);
  }
  return match;
}
