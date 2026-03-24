export type Provider = "ollama" | "openrouter" | "opencode";

export type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

export type OpenRouterTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
    };
  };
};

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

export type ProviderOption = {
  value: Provider;
  name: string;
  sub: string;
  configurable?: boolean;
};

export type ProviderLabel = {
  name: string;
  sub: string;
};

export type ProviderConfig = {
  ollamaBaseUrl: string;
  ollamaModel: string;
};

export type SystemPromptContext = {
  systemPrompt: string;
  currentDocumentSystemPrompt: string;
  spaceId: string;
  documentId: string;
};

export type ProviderContext = {
  history: ChatMessage[];
  assistantMessageIndex: number;
  config: ProviderConfig;
  maxAgentSteps: number;
  signal?: AbortSignal;
  appendAssistantText: (messageIndex: number, text: string) => void;
  setAssistantContent: (messageIndex: number, text: string) => void;
  setAssistantReasoning: (messageIndex: number, reasoning?: string) => void;
  pushConversationMessage: (message: ChatMessage) => void;
  pushStatusMessage: (content: string) => void;
  createAssistantPlaceholder: () => number;
  getOpenRouterTools: () => Promise<readonly OpenRouterTool[]>;
  requestToolPermission: (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<boolean>;
  executeToolCall: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

export interface AIChatAppProvider {
  option: ProviderOption;
  getLabel: (config: ProviderConfig) => ProviderLabel;
  buildSystemPrompt: (context: SystemPromptContext) => string;
  send: (context: ProviderContext) => Promise<void>;
}
