export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  thinking?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
};

export type AIProvider =
  | { provider: "anthropic"; apiKey: string; model: string }
  | { provider: "openai"; apiKey: string; model: string }
  | { provider: "openrouter"; apiKey: string; model: string }
  | { provider: "opencode-zen"; apiKey: string; model: string }
  | { provider: "ollama"; baseUrl: string; model: string };
