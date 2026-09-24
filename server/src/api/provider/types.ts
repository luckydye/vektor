/** An image loaded from Vektor storage for a single model request. Never persist `data`. */
export type ChatImage = {
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
};

/** A durable reference to an image attachment stored with chat history. */
export type ChatImageAttachment = {
  key: string;
  mediaType: ChatImage["mediaType"];
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  thinking?: string | null;
  /** Request-only image payloads, hydrated from `imageAttachments` by the chat route. */
  images?: ChatImage[];
  /** Image attachment identities persisted with chat history. */
  imageAttachments?: ChatImageAttachment[];
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
