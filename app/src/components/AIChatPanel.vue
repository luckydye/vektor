<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from "vue";
import { marked } from "marked";
import { Actions } from "../utils/actions.ts";
import { useSpace } from "../composeables/useSpace.ts";
import { api } from "../api/client.ts";
import DockedPanel from "./DockedPanel.vue";
import { useDockedWindows } from "../composeables/useDockedWindows.ts";
import {
  getSessionsForSpace,
  saveSession,
  deleteSession,
  type ChatSession,
} from "../composeables/useChatSessions.ts";

const props = defineProps({
  documentId: {
    type: String,
    default: "",
  },
});

const SYSTEM_PROMPT = `You are a helpful AI assistant integrated into a wiki/documentation system.
You help users understand and work with their documents. Be concise, accurate, and helpful.
Use tools when they help produce a better answer. Always explain what information you're looking up before making a tool call.

## App Documents
Documents with type "app" render their HTML content in a sandboxed iframe. Use them to build interactive client-side apps with HTML + JavaScript. To create one, call createDocument with the full HTML as content and type set to "app". To update the running app, call updateDocument with the new HTML. The iframe allows scripts but has no access to the parent wiki page.

You have a special tool called "runAgent" that spawns an autonomous sub-agent. The sub-agent runs in the background with its own tool loop and can perform multi-step tasks independently. Use it when a task requires several chained actions — for example researching across multiple documents, fetching external content and writing a summary, or any workflow that would need many sequential tool calls. Provide a clear system prompt telling the sub-agent its goal and constraints, and a content message with the specific task. The sub-agent's progress logs and final result will be streamed back to the user automatically. Prefer runAgent over doing many tool calls yourself when the work is self-contained and can be delegated.`;

const CURRENT_DOCUMENT_SYSTEM_PROMPT = `IMPORTANT: You have access to a tool to get the current document content. When a user asks questions about "this document", "the page", "the current content", or anything that requires seeing the document, you MUST use the tool.

To request the document content, include in your response:
[REQUEST_DOCUMENT_CONTENT]

When you see [DOCUMENT_CONTENT] in the conversation, that's the document content provided to you.`;

// ── Provider types ────────────────────────────────────────────────────────────

type Provider = "ollama" | "openrouter";

type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

type ToolApproval = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "denied";
};

type SubAgentState = {
  status: "running" | "completed" | "failed";
  logs: string[];
  result?: string;
  error?: string;
};

type UIMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  reasoning?: string;
  timestamp: number;
  toolApproval?: ToolApproval;
  subAgent?: SubAgentState;
};

// ── State ─────────────────────────────────────────────────────────────────────

const { currentSpaceId } = useSpace();
const { toggle: toggleWindow, windows: dockedWindows } = useDockedWindows();
const isOpen = computed(() => dockedWindows.value.get("ai-chat")?.open ?? false);
const messageInput = ref("");
const messages = ref<UIMessage[]>([]);
const messagesContainer = ref<HTMLElement | null>(null);
const isGenerating = ref(false);

// Provider selection
const selectedProvider = ref<Provider>("openrouter");
const showProviderDropdown = ref(false);
const showProviderConfig = ref(false);
const ollamaBaseUrl = ref("http://localhost:11434");
const ollamaModel = ref("llama3.2");

// Conversation history for fetch-based providers
const conversationHistory = ref<ChatMessage[]>([]);
const pendingToolApprovalResolvers = new Map<string, (allowed: boolean) => void>();
let abortController: AbortController | null = null;

// Session persistence
const currentSessionId = ref<string | null>(null);
const sessions = ref<ChatSession[]>([]);
const showSessionPicker = ref(false);

// ── Config persistence ────────────────────────────────────────────────────────

function loadUIState() {
  // State is now managed by useDockedWindows composable with localStorage persistence.
  // Migrate old state format if present.
  const saved = localStorage.getItem("ai-chat-ui-state");
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved) as {
      isOpen?: boolean;
      isDocked?: boolean;
      dockSide?: "left" | "right";
    };
    if (parsed.isOpen) {
      toggleWindow("ai-chat", {
        mode: parsed.isDocked ? "docked" : "floating",
        side: parsed.dockSide ?? "right",
        width: 380,
      });
    }
    localStorage.removeItem("ai-chat-ui-state");
  } catch {
    localStorage.removeItem("ai-chat-ui-state");
  }
}

function loadProviderConfig() {
  selectedProvider.value =
    (localStorage.getItem("ai-provider") as Provider) ?? "openrouter";
  ollamaBaseUrl.value = localStorage.getItem("ai-ollama-url") ?? "http://localhost:11434";
  ollamaModel.value = localStorage.getItem("ai-ollama-model") ?? "llama3.2";
}

function saveProviderConfig() {
  localStorage.setItem("ai-provider", selectedProvider.value);
  localStorage.setItem("ai-ollama-url", ollamaBaseUrl.value);
  localStorage.setItem("ai-ollama-model", ollamaModel.value);
  showProviderConfig.value = false;
  showProviderDropdown.value = false;
}

function selectProvider(provider: Provider) {
  selectedProvider.value = provider;
  showProviderDropdown.value = false;
  showProviderConfig.value = provider === "ollama";
  conversationHistory.value = [];
}

const providerLabel = computed(() => {
  switch (selectedProvider.value) {
    case "ollama":
      return { name: ollamaModel.value || "Ollama", sub: "Local" };
    case "openrouter":
      return { name: "gpt-oss", sub: "OpenRouter" };
  }
});

const canSend = computed(() => {
  return !!(messageInput.value.trim() && !isGenerating.value);
});

// ── Tool execution ────────────────────────────────────────────────────────────

const TOOL_REGEX = /```tool\n([\s\S]*?)\n```/g;
const MAX_AGENT_STEPS = 10;

const OPENROUTER_TOOLS = [
  {
    type: "function",
    function: {
      name: "getDocument",
      description: "Get a document by ID.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          documentId: { type: "string" },
          rev: { type: "number" },
        },
        required: ["spaceId", "documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listDocuments",
      description: "List documents in a space with pagination.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
          parentId: { type: "string" },
          categoryId: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchDocuments",
      description: "Search documents in a space.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          q: { type: "string" },
          limit: { type: "number" },
          offset: { type: "number" },
          filters: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getDocumentHistory",
      description: "Get revision history for a document.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          documentId: { type: "string" },
        },
        required: ["spaceId", "documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getDocumentChildren",
      description: "Get child documents of a document.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          documentId: { type: "string" },
        },
        required: ["spaceId", "documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getDocumentContributors",
      description: "Get contributors for a document.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          documentId: { type: "string" },
        },
        required: ["spaceId", "documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getDocumentComments",
      description: "Get comments on a document.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          documentId: { type: "string" },
        },
        required: ["spaceId", "documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSpace",
      description: "Get a space by ID.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listSpaces",
      description: "List all spaces the user has access to.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSpaceMembers",
      description: "List members in a space.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getMyPermissions",
      description: "Get current user's permissions in a space.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listCategories",
      description: "List categories in a space.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getCategory",
      description: "Get a category by ID.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          categoryId: { type: "string" },
        },
        required: ["spaceId", "categoryId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getCategoryDocuments",
      description: "List documents in a category.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          categorySlug: { type: "string" },
        },
        required: ["spaceId", "categorySlug"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listProperties",
      description: "List all properties used in a space.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listUsers",
      description: "List all users.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getUser",
      description: "Get a user by ID.",
      parameters: {
        type: "object",
        properties: {
          userId: { type: "string" },
        },
        required: ["userId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getDocumentAuditLogs",
      description: "Get audit logs for a document.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          documentId: { type: "string" },
          limit: { type: "number" },
        },
        required: ["spaceId", "documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getSpaceAuditLogs",
      description: "Get audit logs for a space.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          limit: { type: "number" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listExtensions",
      description: "List all extensions in a space.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getExtension",
      description: "Get a specific extension.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          extensionId: { type: "string" },
        },
        required: ["spaceId", "extensionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listWebhooks",
      description: "List webhooks in a space.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getWebhook",
      description: "Get a specific webhook.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          webhookId: { type: "string" },
        },
        required: ["spaceId", "webhookId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listAccessTokens",
      description: "List access tokens in a space.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
        },
        required: ["spaceId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAccessToken",
      description: "Get a specific access token.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          tokenId: { type: "string" },
        },
        required: ["spaceId", "tokenId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getLatestWorkflowRun",
      description: "Get the latest workflow run for a document.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          documentId: { type: "string" },
        },
        required: ["spaceId", "documentId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getWorkflowRun",
      description: "Get the status of a workflow run.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          runId: { type: "string" },
        },
        required: ["spaceId", "runId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getLinkPreview",
      description: "Fetch preview metadata for a URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runAgent",
      description:
        "Run a sub-agent that can autonomously use tools (read/write documents, search, fetch URLs, etc.) to accomplish a complex task. The sub-agent runs in the background and its progress logs are streamed back. Use this for multi-step tasks that require tool use.",
      parameters: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "System prompt / instructions for the sub-agent",
          },
          content: {
            type: "string",
            description: "The user message / task for the sub-agent to work on",
          },
          allowedTools: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional list of tool names to allow: read_document, prompt, log, http_fetch, write_document, search_documents, upload_artifact, html_to_markdown, sitemap_download, json_to_table, for_each_file",
          },
        },
        required: ["prompt", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "createDocument",
      description:
        "Create a new document in a space. Returns the created document with its ID.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          content: { type: "string", description: "HTML content for the document" },
          type: {
            type: "string",
            description:
              "Optional document type. Use 'app' to create an interactive HTML+JS app rendered in a sandboxed iframe.",
          },
          parentId: { type: "string", description: "Optional parent document ID" },
          categoryId: { type: "string", description: "Optional category ID" },
          properties: { type: "object", description: "Optional key-value properties" },
        },
        required: ["spaceId", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateDocument",
      description: "Update the content of an existing document.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          documentId: { type: "string" },
          content: { type: "string", description: "New HTML content for the document" },
        },
        required: ["spaceId", "documentId", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "saveRevision",
      description:
        "Save a new revision of a document with an optional message describing the change.",
      parameters: {
        type: "object",
        properties: {
          spaceId: { type: "string" },
          documentId: { type: "string" },
          html: { type: "string", description: "HTML content for the revision" },
          message: { type: "string", description: "Optional revision message" },
        },
        required: ["spaceId", "documentId", "html"],
      },
    },
  },
] as const;

async function spawnAndPollAgent(
  prompt: string,
  content: string,
  allowedTools?: string[],
): Promise<{ status: string; result?: string; error?: string }> {
  if (!currentSpaceId.value) throw new Error("No space selected");

  const inputs: Record<string, unknown> = { prompt, content };
  if (allowedTools) inputs.allowedTools = JSON.stringify(allowedTools);

  // Add a sub-agent message to the UI
  const msgIndex = messages.value.length;
  messages.value.push({
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    subAgent: {
      status: "running",
      logs: [],
    },
  });
  scrollToBottom();

  const response = await api.jobs.runStream(
    currentSpaceId.value,
    "agent",
    inputs,
    abortController?.signal,
  );

  if (!response.ok) throw new Error(`Job run failed: ${response.status}`);
  if (!response.body) throw new Error("No response body");

  const msg = messages.value[msgIndex];

  for await (const event of parseSSEStream(response.body)) {
    if (!msg.subAgent) break;
    const type = event.type as string;

    if (type === "log") {
      msg.subAgent.logs.push(event.message as string);
      scrollToBottom();
    } else if (type === "output") {
      msg.subAgent.status = "completed";
      const outputs = event.outputs as Record<string, unknown>;
      const outputContent = outputs?.content as
        | { type: string; value: string }
        | string
        | undefined;
      const result =
        typeof outputContent === "object" && outputContent?.value
          ? outputContent.value
          : typeof outputContent === "string"
            ? outputContent
            : "";
      msg.subAgent.result = result;
      scrollToBottom();
      return { status: "completed", result };
    } else if (type === "error") {
      msg.subAgent.status = "failed";
      msg.subAgent.error = event.error as string;
      scrollToBottom();
      return { status: "failed", error: event.error as string };
    }
  }

  throw new Error("Agent stream ended unexpectedly");
}

async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case "getDocument":
      return api.document.get(
        args.spaceId as string,
        args.documentId as string,
        args.rev ? { rev: args.rev as number } : undefined,
      );
    case "listDocuments":
      return api.documents.get(
        args.spaceId as string,
        args as Record<string, string | number | boolean>,
      );
    case "searchDocuments":
      return api.search.get(
        args.spaceId as string,
        args as { q?: string; limit?: number; offset?: number; filters?: string },
      );
    case "getDocumentHistory":
      return api.documentHistory.get(args.spaceId as string, args.documentId as string);
    case "getDocumentChildren":
      return api.documentChildren.get(args.spaceId as string, args.documentId as string);
    case "getDocumentContributors":
      return api.documentContributors.get(
        args.spaceId as string,
        args.documentId as string,
      );
    case "getDocumentComments":
      return api.documentComments.get(args.spaceId as string, args.documentId as string);
    case "getSpace":
      return api.space.get(args.spaceId as string);
    case "listSpaces":
      return api.spaces.get();
    case "getSpaceMembers":
      return api.spaceMembers.get(args.spaceId as string);
    case "getMyPermissions":
      return api.permissions.getMe(args.spaceId as string);
    case "listCategories":
      return api.categories.get(args.spaceId as string);
    case "getCategory":
      return api.category.get(args.spaceId as string, args.categoryId as string);
    case "getCategoryDocuments":
      return (
        await api.documents.get(args.spaceId as string, {
          categorySlugs: args.categorySlug as string,
        })
      ).documents;
    case "listProperties":
      return api.properties.get(args.spaceId as string);
    case "listUsers":
      return api.users.get();
    case "getUser":
      return api.users.getById(args.userId as string);
    case "getDocumentAuditLogs":
      return api.documentAuditLogs.get(
        args.spaceId as string,
        args.documentId as string,
        args.limit ? { limit: args.limit as number } : undefined,
      );
    case "getSpaceAuditLogs":
      return api.auditLogs.get(
        args.spaceId as string,
        args.limit ? { limit: args.limit as number } : undefined,
      );
    case "listExtensions":
      return api.extensions.get(args.spaceId as string);
    case "getExtension":
      return api.extensions.getById(args.spaceId as string, args.extensionId as string);
    case "listWebhooks":
      return api.webhooks.get(args.spaceId as string);
    case "getWebhook":
      return api.webhooks.getById(args.spaceId as string, args.webhookId as string);
    case "listAccessTokens":
      return api.accessTokens.get(args.spaceId as string);
    case "getAccessToken":
      return api.accessTokens.getById(args.spaceId as string, args.tokenId as string);
    case "getLatestWorkflowRun":
      return api.workflows.getLatestRun(
        args.spaceId as string,
        args.documentId as string,
      );
    case "getWorkflowRun":
      return api.workflows.getRun(args.spaceId as string, args.runId as string);
    case "getLinkPreview":
      return api.linkPreview.get(args.url as string);
    case "createDocument":
      return api.documents.post(args.spaceId as string, {
        content: args.content as string,
        type: (args.type as string) ?? undefined,
        parentId: (args.parentId as string) ?? undefined,
        categoryId: (args.categoryId as string) ?? undefined,
        properties: (args.properties as Record<string, string>) ?? undefined,
      });
    case "updateDocument":
      return api.document.put(
        args.spaceId as string,
        args.documentId as string,
        args.content as string,
      );
    case "saveRevision":
      return api.document.post(args.spaceId as string, args.documentId as string, {
        html: args.html as string,
        message: (args.message as string) ?? undefined,
      });
    case "runAgent":
      return await spawnAndPollAgent(
        args.prompt as string,
        args.content as string,
        args.allowedTools as string[] | undefined,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function requestToolPermission(
  name: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const id = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  messages.value.push({
    role: "assistant",
    content: `Tool call requested: ${name}`,
    timestamp: Date.now(),
    toolApproval: {
      id,
      name,
      args,
      status: "pending",
    },
  });
  scrollToBottom();

  return await new Promise<boolean>((resolve) => {
    pendingToolApprovalResolvers.set(id, resolve);
  });
}

function resolveToolPermission(id: string, allowed: boolean) {
  const message = messages.value.find((msg) => msg.toolApproval?.id === id);
  if (message?.toolApproval) {
    message.toolApproval.status = allowed ? "approved" : "denied";
  }

  const resolver = pendingToolApprovalResolvers.get(id);
  if (resolver) {
    pendingToolApprovalResolvers.delete(id);
    resolver(allowed);
  }
}

function allowToolPermission(id: string) {
  resolveToolPermission(id, true);
}

function denyToolPermission(id: string) {
  resolveToolPermission(id, false);
}

function extractToolCalls(
  content: string,
): Array<{ name: string; args: Record<string, unknown> }> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const matches = content.matchAll(TOOL_REGEX);
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && parsed.args) {
        calls.push(parsed);
      }
    } catch {
      // Invalid JSON, skip
    }
  }
  return calls;
}

function removeToolCalls(content: string): string {
  return content.replace(TOOL_REGEX, "").trim();
}

function getDocumentContent(): string {
  const documentView = document.querySelector("document-view") as any;
  if (documentView?.editor) {
    return documentView.editor.getHTML() || "";
  }
  const shadowRoot = documentView?.shadowRoot;
  if (shadowRoot) {
    return shadowRoot.querySelector('[part="content"]')?.textContent || "";
  }
  return "";
}

// ── Fetch-based providers (Ollama / OpenRouter) ───────────────────────────────

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const parts = buffer.split("\n\n");
      buffer = parts.pop()!;

      for (const part of parts) {
        for (const line of part.split("\n")) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6);
            if (payload === "[DONE]") return;
            try {
              yield JSON.parse(payload) as Record<string, unknown>;
            } catch {
              // skip malformed JSON
            }
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function fetchStreamingCompletion(
  history: ChatMessage[],
  onDelta: (text: string) => void,
  tools?: typeof OPENROUTER_TOOLS,
  signal?: AbortSignal,
): Promise<{ content: string; reasoning?: string; toolCalls?: ToolCall[] }> {
  const isOllama = selectedProvider.value === "ollama";
  const url = isOllama
    ? `${ollamaBaseUrl.value.replace(/\/$/, "")}/v1/chat/completions`
    : "/api/v1/chat/completions";

  const model = isOllama ? ollamaModel.value : "openai/gpt-oss-120b";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: history,
      tools,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`API error ${response.status}: ${await response.text()}`);
  }

  if (!response.body) throw new Error("No response body");

  let content = "";
  let reasoning = "";
  const toolCallsMap = new Map<number, ToolCall>();

  for await (const chunk of parseSSEStream(response.body)) {
    const delta = (chunk as any).choices?.[0]?.delta;
    if (!delta) continue;

    if (delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    if (delta.reasoning) {
      reasoning += delta.reasoning;
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls as any[]) {
        const idx = tc.index as number;
        const existing = toolCallsMap.get(idx);
        if (!existing) {
          toolCallsMap.set(idx, {
            id: tc.id ?? "",
            type: tc.type ?? "function",
            function: {
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            },
          });
        } else {
          if (tc.function?.arguments) {
            existing.function.arguments += tc.function.arguments;
          }
        }
      }
    }
  }

  const toolCalls =
    toolCallsMap.size > 0
      ? [...toolCallsMap.entries()].sort(([a], [b]) => a - b).map(([, v]) => v)
      : [];

  return {
    content: content || reasoning,
    reasoning: content ? reasoning || undefined : undefined,
    toolCalls,
  };
}

async function sendWithFetch(message: string, assistantMessageIndex: number) {
  if (conversationHistory.value.length === 0) {
    if (!currentSpaceId.value) throw new Error("No space selected");
    const openRouterToolPrompt =
      selectedProvider.value === "openrouter"
        ? "\n\nIMPORTANT: Use native function tool calls via the API tool_calls field. Do not emit ```tool blocks."
        : "";
    conversationHistory.value = [
      {
        role: "system",
        content: `${SYSTEM_PROMPT}${openRouterToolPrompt}\n\nCurrent context:\n- spaceId: ${currentSpaceId.value}\n- documentId: ${props.documentId}\n\n${CURRENT_DOCUMENT_SYSTEM_PROMPT}`,
      },
    ];
  }

  conversationHistory.value.push({ role: "user", content: message });

  function streamTo(idx: number) {
    return (text: string) => {
      messages.value[idx].content += text;
      scrollToBottom();
    };
  }

  if (selectedProvider.value !== "openrouter") {
    let completed = false;
    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
      messages.value[assistantMessageIndex].content = "";
      const { content, reasoning } = await fetchStreamingCompletion(
        conversationHistory.value,
        streamTo(assistantMessageIndex),
        undefined,
        abortController?.signal,
      );

      if (content.includes("[REQUEST_DOCUMENT_CONTENT]")) {
        messages.value[assistantMessageIndex].content = content
          .replace("[REQUEST_DOCUMENT_CONTENT]", "")
          .trim();
        messages.value[assistantMessageIndex].reasoning = reasoning;
        conversationHistory.value.push({ role: "assistant", content });

        const docContent = getDocumentContent();
        messages.value.push({
          role: "assistant",
          content: "📄 Document content provided",
          timestamp: Date.now(),
        });
        scrollToBottom();

        conversationHistory.value.push({
          role: "user",
          content: `[DOCUMENT_CONTENT]\n${docContent}\n\nNow answer the user's question based on this document content.`,
        });
        continue;
      }

      const toolCalls = extractToolCalls(content);
      if (toolCalls.length > 0) {
        messages.value[assistantMessageIndex].content = removeToolCalls(content);
        messages.value[assistantMessageIndex].reasoning = reasoning;
        conversationHistory.value.push({ role: "assistant", content });

        for (const toolCall of toolCalls) {
          const allowed = await requestToolPermission(toolCall.name, toolCall.args);
          if (!allowed) {
            messages.value.push({
              role: "assistant",
              content: `🛑 Tool denied: ${toolCall.name}`,
              timestamp: Date.now(),
            });
            scrollToBottom();
            conversationHistory.value.push({
              role: "user",
              content: `[TOOL_ERROR]\nUser denied permission for ${toolCall.name}`,
            });
            continue;
          }

          try {
            const result = await executeToolCall(toolCall.name, toolCall.args);
            messages.value.push({
              role: "assistant",
              content: `🔧 Tool result: ${toolCall.name}`,
              timestamp: Date.now(),
            });
            scrollToBottom();
            conversationHistory.value.push({
              role: "user",
              content: `[TOOL_RESULT]\n${JSON.stringify(result, null, 2)}\n\nNow answer the user's question using this data.`,
            });
          } catch (toolError) {
            const errorMsg =
              toolError instanceof Error ? toolError.message : "Tool execution failed";
            messages.value.push({
              role: "assistant",
              content: `❌ Tool error: ${toolCall.name} - ${errorMsg}`,
              timestamp: Date.now(),
            });
            scrollToBottom();
            conversationHistory.value.push({
              role: "user",
              content: `[TOOL_ERROR]\n${errorMsg}`,
            });
          }
        }

        const followUpIdx = messages.value.length;
        messages.value.push({ role: "assistant", content: "", timestamp: Date.now() });
        const followUp = await fetchStreamingCompletion(
          conversationHistory.value,
          streamTo(followUpIdx),
          undefined,
          abortController?.signal,
        );
        messages.value[followUpIdx].reasoning = followUp.reasoning;
        conversationHistory.value.push({ role: "assistant", content: followUp.content });
        scrollToBottom();
        completed = true;
        break;
      }

      messages.value[assistantMessageIndex].reasoning = reasoning;
      conversationHistory.value.push({ role: "assistant", content });
      completed = true;
      break;
    }
    if (!completed) {
      throw new Error(
        `Agent loop ended without a final response after ${MAX_AGENT_STEPS} steps`,
      );
    }
    return;
  }

  let completed = false;
  let currentAssistantIdx = assistantMessageIndex;
  for (let i = 0; i < MAX_AGENT_STEPS; i++) {
    messages.value[currentAssistantIdx].content = "";
    const { content, reasoning, toolCalls } = await fetchStreamingCompletion(
      conversationHistory.value,
      streamTo(currentAssistantIdx),
      OPENROUTER_TOOLS,
      abortController?.signal,
    );

    if (content.includes("[REQUEST_DOCUMENT_CONTENT]")) {
      messages.value[currentAssistantIdx].content = content
        .replace("[REQUEST_DOCUMENT_CONTENT]", "")
        .trim();
      messages.value[currentAssistantIdx].reasoning = reasoning;
      conversationHistory.value.push({ role: "assistant", content });

      const docContent = getDocumentContent();
      messages.value.push({
        role: "assistant",
        content: "📄 Document content provided",
        timestamp: Date.now(),
      });
      scrollToBottom();

      conversationHistory.value.push({
        role: "user",
        content: `[DOCUMENT_CONTENT]\n${docContent}\n\nNow answer the user's question based on this document content.`,
      });
      currentAssistantIdx = messages.value.length;
      messages.value.push({ role: "assistant", content: "", timestamp: Date.now() });
      continue;
    }

    if (!toolCalls || toolCalls.length === 0) {
      messages.value[currentAssistantIdx].reasoning = reasoning;
      conversationHistory.value.push({ role: "assistant", content });
      completed = true;
      break;
    }

    messages.value[currentAssistantIdx].reasoning = reasoning;
    conversationHistory.value.push({
      role: "assistant",
      content: content || null,
      tool_calls: toolCalls,
    });

    for (const toolCall of toolCalls) {
      const name = toolCall.function?.name || "unknown";
      let args: Record<string, unknown> = {};

      try {
        args = JSON.parse(toolCall.function?.arguments || "{}") as Record<
          string,
          unknown
        >;
      } catch {
        const error = `Invalid tool arguments for ${name}`;
        messages.value.push({
          role: "assistant",
          content: `❌ Tool error: ${error}`,
          timestamp: Date.now(),
        });
        conversationHistory.value.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error }),
        });
        continue;
      }

      const allowed = await requestToolPermission(name, args);
      if (!allowed) {
        const denied = { error: `User denied permission for ${name}` };
        messages.value.push({
          role: "assistant",
          content: `🛑 Tool denied: ${name}`,
          timestamp: Date.now(),
        });
        conversationHistory.value.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(denied),
        });
        continue;
      }

      try {
        const result = await executeToolCall(name, args);
        messages.value.push({
          role: "assistant",
          content: `🔧 Tool result: ${name}`,
          timestamp: Date.now(),
        });
        conversationHistory.value.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(result),
        });
      } catch (toolError) {
        const errorMsg =
          toolError instanceof Error ? toolError.message : "Tool execution failed";
        messages.value.push({
          role: "assistant",
          content: `❌ Tool error: ${name} - ${errorMsg}`,
          timestamp: Date.now(),
        });
        conversationHistory.value.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify({ error: errorMsg }),
        });
      }
      scrollToBottom();
    }

    currentAssistantIdx = messages.value.length;
    messages.value.push({ role: "assistant", content: "", timestamp: Date.now() });
  }

  if (!completed) {
    throw new Error(
      `Agent loop ended without a final response after ${MAX_AGENT_STEPS} steps`,
    );
  }
}

// ── Session management ────────────────────────────────────────────────────────

async function loadSessions() {
  sessions.value = await getSessionsForSpace(currentSpaceId.value);
}

function startNewChat() {
  currentSessionId.value = null;
  messages.value = [];
  conversationHistory.value = [];
  showSessionPicker.value = false;
  messages.value.push({
    role: "assistant",
    content: "Hello! I'm here to help you with this document. Ask me anything!",
    timestamp: Date.now(),
  });
}

function resumeSession(session: ChatSession) {
  currentSessionId.value = session.id;
  messages.value = session.messages as UIMessage[];
  conversationHistory.value = session.conversationHistory as ChatMessage[];
  showSessionPicker.value = false;
  scrollToBottom();
}

async function persistSession() {
  if (!currentSessionId.value) return;
  const session = sessions.value.find((s) => s.id === currentSessionId.value);
  if (!session) return;
  (session as any).messages = messages.value;
  (session as any).conversationHistory = conversationHistory.value;
  session.updatedAt = Date.now();
  await saveSession(session);
}

async function removeSession(id: string) {
  await deleteSession(id);
  sessions.value = sessions.value.filter((s) => s.id !== id);
  if (currentSessionId.value === id) {
    if (sessions.value.length > 0) {
      showSessionPicker.value = true;
      currentSessionId.value = null;
      messages.value = [];
      conversationHistory.value = [];
    } else {
      startNewChat();
    }
  }
}

// ── Send message ──────────────────────────────────────────────────────────────

function cancelGeneration() {
  abortController?.abort();
  abortController = null;
}

async function sendMessage() {
  if (!canSend.value) return;

  const message = messageInput.value.trim();

  showSessionPicker.value = false;

  if (!currentSessionId.value) {
    const newSession: ChatSession = {
      id: crypto.randomUUID(),
      title: message.slice(0, 60),
      spaceId: currentSpaceId.value,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      conversationHistory: [],
    };
    sessions.value.unshift(newSession);
    currentSessionId.value = newSession.id;
    await saveSession(newSession);
  }

  messages.value.push({ role: "user", content: message, timestamp: Date.now() });
  messageInput.value = "";
  scrollToBottom();

  isGenerating.value = true;
  abortController = new AbortController();
  const assistantMessageIndex = messages.value.length;
  messages.value.push({ role: "assistant", content: "", timestamp: Date.now() });

  try {
    await sendWithFetch(message, assistantMessageIndex);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      // Keep whatever content was streamed so far
      conversationHistory.value.push({
        role: "assistant",
        content: messages.value[assistantMessageIndex].content || "(cancelled)",
      });
    } else {
      const errorMessage =
        error instanceof Error ? error.message : "AI generation failed";
      messages.value[assistantMessageIndex].content =
        `Sorry, I encountered an error: ${errorMessage}`;
    }
  } finally {
    abortController = null;
    isGenerating.value = false;
    scrollToBottom();
    await persistSession();
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function scrollToBottom() {
  setTimeout(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  }, 50);
}

const markdownRenderer = new marked.Renderer();
markdownRenderer.html = ({ text }: { text: string }) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function renderMarkdown(content: string): string {
  return marked.parse(content, {
    breaks: true,
    gfm: true,
    renderer: markdownRenderer,
  }) as string;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

Actions.register("ai-chat:toggle", {
  title: "AI Chat",
  icon: () => "sparkles",
  description: "Open AI chat to ask questions about this document",
  group: "document",
  run: async () => {
    toggleWindow("ai-chat", { side: "right", width: 380 });
  },
});

onMounted(async () => {
  loadUIState();
  loadProviderConfig();
  await loadSessions();

  if (sessions.value.length > 0) {
    showSessionPicker.value = true;
  } else {
    messages.value.push({
      role: "assistant",
      content: "Hello! I'm here to help you with this document. Ask me anything!",
      timestamp: Date.now(),
    });
  }
});

onUnmounted(() => {
  for (const resolve of pendingToolApprovalResolvers.values()) {
    resolve(false);
  }
  pendingToolApprovalResolvers.clear();
  Actions.unregister("ai-chat:toggle");
});
</script>

<template>
  <DockedPanel
    id="ai-chat"
    title="AI Assistant"
    default-side="right"
    :default-width="380"
  >
    <div class="flex flex-col h-full bg-neutral-50">
      <!-- Provider selector -->
      <div class="px-3 py-2 border-b border-neutral-100 bg-neutral-10 shrink-0 relative">
        <div
          class="flex items-center justify-between px-2.5 py-1.5 border border-neutral-100 rounded-lg text-sm cursor-pointer hover:bg-neutral-50 transition-colors select-none"
          @click="showProviderDropdown = !showProviderDropdown"
        >
          <div class="flex items-center gap-2">
            <svg class="w-4 h-4 text-primary-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/>
            </svg>
            <span class="font-medium text-neutral-800">{{ providerLabel.name }}</span>
            <span class="text-xs text-neutral-500 font-normal">{{ providerLabel.sub }}</span>
          </div>
          <div class="flex items-center gap-1.5">
            <!-- Settings icon for configurable providers -->
            <button
              v-if="selectedProvider === 'ollama'"
              class="p-0.5 text-neutral-500 hover:text-neutral-700 transition-colors"
              @click.stop="showProviderConfig = !showProviderConfig; showProviderDropdown = false"
              title="Configure provider"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>
              </svg>
            </button>
            <svg class="w-3.5 h-3.5 text-neutral-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
            </svg>
          </div>
        </div>

        <!-- Dropdown -->
        <div
          v-if="showProviderDropdown"
          class="absolute top-full left-3 right-3 mt-1 bg-neutral-10 border border-neutral-100 rounded-lg shadow-lg z-20 overflow-hidden"
        >
          <button
            v-for="option in [
              { value: 'openrouter', name: 'OpenRouter', sub: 'Cloud' },
              { value: 'ollama', name: 'Ollama', sub: 'Local' },
            ]"
            :key="option.value"
            class="w-full flex items-center justify-between px-3 py-2.5 text-sm hover:bg-neutral-50 transition-colors text-left"
            :class="selectedProvider === option.value ? 'bg-primary-50' : ''"
            @click="selectProvider(option.value as Provider)"
          >
            <div class="flex items-center gap-2">
              <span class="font-medium text-neutral-800">{{ option.name }}</span>
              <span class="text-xs text-neutral-500">{{ option.sub }}</span>
            </div>
            <svg v-if="selectedProvider === option.value" class="w-3.5 h-3.5 text-primary-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
              <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Provider config panel -->
      <div
        v-if="showProviderConfig && selectedProvider === 'ollama'"
        class="px-3 py-3 border-b border-neutral-100 bg-neutral-50 shrink-0 space-y-2"
      >
        <template v-if="selectedProvider === 'ollama'">
          <div>
            <label class="block text-xs text-neutral-600 mb-1">Base URL</label>
            <input
              v-model="ollamaBaseUrl"
              type="text"
              placeholder="http://localhost:11434"
              class="w-full px-2.5 py-1.5 text-sm bg-neutral-10 text-neutral-800 placeholder-neutral-400 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary-400"
            />
          </div>
          <div>
            <label class="block text-xs text-neutral-600 mb-1">Model</label>
            <input
              v-model="ollamaModel"
              type="text"
              placeholder="llama3.2"
              class="w-full px-2.5 py-1.5 text-sm bg-neutral-10 text-neutral-800 placeholder-neutral-400 border border-neutral-200 rounded-lg focus:outline-none focus:border-primary-400"
            />
          </div>
        </template>
        <div class="flex gap-2 pt-1">
          <button
            @click="saveProviderConfig"
            class="px-3 py-1.5 text-xs font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            Save
          </button>
          <button
            @click="showProviderConfig = false"
            class="px-3 py-1.5 text-xs text-neutral-600 bg-neutral-10 border border-neutral-200 rounded-lg hover:bg-neutral-50 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>

      <!-- Sessions picker -->
      <div v-if="showSessionPicker" class="flex-1 overflow-y-auto px-3 py-4">
        <p class="text-[11px] font-medium text-neutral-400 uppercase tracking-wide mb-3 px-1">Recent conversations</p>
        <div class="space-y-0.5">
          <div
            v-for="session in sessions"
            :key="session.id"
            class="group flex items-center gap-2 px-3 py-2.5 rounded-lg hover:bg-neutral-100 cursor-pointer transition-colors"
            @click="resumeSession(session)"
          >
            <div class="flex-1 min-w-0">
              <p class="text-sm text-neutral-800 truncate">{{ session.title }}</p>
              <p class="text-xs text-neutral-400 mt-0.5">{{ new Date(session.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) }}</p>
            </div>
            <button
              @click.stop="removeSession(session.id)"
              class="opacity-0 group-hover:opacity-100 p-1 text-neutral-400 hover:text-red-500 transition-all shrink-0"
              title="Delete"
            >
              <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
              </svg>
            </button>
          </div>
        </div>
      </div>

      <!-- Messages -->
      <div
        v-else
        ref="messagesContainer"
        class="flex-1 overflow-y-auto px-3 py-4 space-y-3"
        @click="showProviderDropdown = false"
      >
        <div
          v-for="(message, index) in messages"
          :key="index"
          :class="[
            'animate-message-slide-in',
            message.role === 'system' ? 'flex justify-center' : 'flex gap-2',
            message.role === 'user' ? 'justify-end' : 'justify-start',
          ]"
        >
          <div
            v-if="message.role === 'system'"
            class="px-3 py-1 bg-neutral-100 text-neutral-600 rounded-full text-xs"
          >
            {{ message.content }}
          </div>
          <template v-else-if="message.role === 'assistant'">
            <!-- Robot avatar -->
            <div class="w-7 h-7 rounded-lg bg-primary-50 border border-primary-100 flex items-center justify-center shrink-0 mt-0.5">
              <svg class="w-4 h-4 text-primary-500" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2a2 2 0 012 2v1h3a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V7a2 2 0 012-2h3V4a2 2 0 012-2zm-3 7a1 1 0 100 2 1 1 0 000-2zm6 0a1 1 0 100 2 1 1 0 000-2zm-6 4h6v1H9v-1z"/>
              </svg>
            </div>
            <div class="flex-1 min-w-0">
              <div class="bg-neutral-10 border border-neutral-100 rounded-xl overflow-hidden shadow-sm">
                <template v-if="message.toolApproval">
                  <div class="px-3.5 py-3 border-b border-neutral-100">
                    <p class="text-sm text-neutral-800 font-medium">Tool permission required</p>
                    <p class="text-xs text-neutral-600 mt-1">
                      Tool: <code>{{ message.toolApproval.name }}</code>
                    </p>
                  </div>
                  <pre class="text-xs">{{ JSON.stringify(message.toolApproval.args, null, 2) }}</pre>
                  <div class="px-3.5 pb-3 pt-1 flex items-center gap-2">
                    <button
                      v-if="message.toolApproval.status === 'pending'"
                      class="px-2.5 py-1.5 text-xs font-medium bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
                      @click="allowToolPermission(message.toolApproval.id)"
                    >
                      Allow
                    </button>
                    <button
                      v-if="message.toolApproval.status === 'pending'"
                      class="px-2.5 py-1.5 text-xs border border-neutral-300 text-neutral-700 rounded-lg hover:bg-neutral-50 transition-colors"
                      @click="denyToolPermission(message.toolApproval.id)"
                    >
                      Deny
                    </button>
                    <span
                      v-if="message.toolApproval.status !== 'pending'"
                      class="text-xs"
                      :class="message.toolApproval.status === 'approved' ? 'text-green-700' : 'text-red-700'"
                    >
                      {{ message.toolApproval.status === "approved" ? "Allowed" : "Denied" }}
                    </span>
                  </div>
                </template>
                <template v-else-if="message.subAgent">
                  <div class="px-3.5 py-3">
                    <div class="flex items-center gap-2 mb-2">
                      <svg class="w-4 h-4 text-primary-500" :class="message.subAgent.status === 'running' ? 'animate-spin' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path v-if="message.subAgent.status === 'running'" d="M12 2a10 10 0 0 1 10 10" stroke-linecap="round"/>
                        <path v-else-if="message.subAgent.status === 'completed'" stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                        <path v-else stroke-linecap="round" d="M18 6L6 18M6 6l12 12"/>
                      </svg>
                      <span class="text-sm font-medium text-neutral-800">
                        Sub-agent
                        <span
                          class="text-xs font-normal ml-1"
                          :class="{
                            'text-primary-500': message.subAgent.status === 'running',
                            'text-green-600': message.subAgent.status === 'completed',
                            'text-red-600': message.subAgent.status === 'failed',
                          }"
                        >{{ message.subAgent.status }}</span>
                      </span>
                    </div>
                    <div v-if="message.subAgent.logs.length" class="bg-neutral-900 text-neutral-200 rounded-lg p-3 text-xs font-mono leading-relaxed max-h-48 overflow-y-auto">
                      <div v-for="(line, i) in message.subAgent.logs" :key="i" class="whitespace-pre-wrap">{{ line }}</div>
                    </div>
                    <div v-if="message.subAgent.result" class="mt-2 text-sm text-neutral-800 leading-relaxed markdown-content" v-html="renderMarkdown(message.subAgent.result)"></div>
                    <div v-if="message.subAgent.error" class="mt-2 text-sm text-red-600">{{ message.subAgent.error }}</div>
                  </div>
                </template>
                <template v-else>
                  <details v-if="message.reasoning" class="border-b border-neutral-100">
                    <summary class="px-3.5 py-2 text-xs text-neutral-500 cursor-pointer select-none hover:bg-neutral-50 transition-colors list-none flex items-center gap-1.5">
                      <svg class="w-3 h-3 shrink-0 transition-transform details-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M9 18l6-6-6-6"/>
                      </svg>
                      Reasoning
                    </summary>
                    <div class="px-3.5 pb-2.5 pt-1 text-xs text-neutral-500 leading-relaxed italic border-t border-neutral-100 bg-neutral-50">{{ message.reasoning }}</div>
                  </details>
                  <div class="px-3.5 py-3 text-sm text-neutral-800 leading-relaxed markdown-content" v-html="renderMarkdown(message.content)"></div>
                </template>
              </div>
              <!-- Timestamp + model + copy/refresh icons -->
              <div class="flex items-center justify-between mt-1.5 px-0.5">
                <span class="text-[11px] text-neutral-500">
                  {{ new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }}
                  &nbsp;·&nbsp; {{ providerLabel.name }}
                </span>
                <div class="flex items-center gap-1">
                  <button class="p-0.5 text-neutral-400 hover:text-neutral-600 transition-colors" title="Copy" @click="navigator.clipboard.writeText(message.content)">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </template>
          <div
            v-else
            class="max-w-[80%] bg-primary-600 text-white rounded-xl px-3.5 py-2.5 ml-auto"
          >
            <p class="text-sm whitespace-pre-wrap leading-relaxed">{{ message.content }}</p>
          </div>
        </div>
      </div>

      <!-- Suggestion chips -->
      <div v-if="!showSessionPicker" class="px-3 py-2 flex gap-2 flex-wrap shrink-0 border-t border-neutral-100 bg-neutral-50">
        <button
          v-for="chip in ['Create pipeline', 'Error handling', 'Optimize', 'Add AI node']"
          :key="chip"
          class="px-3 py-1 text-xs text-neutral-700 bg-neutral-10 border border-neutral-100 rounded-full hover:bg-neutral-50 hover:border-neutral-200 transition-colors"
          @click="messageInput = chip"
        >
          {{ chip }}
        </button>
      </div>

      <!-- Input bar -->
      <div class="px-3 pb-3 pt-2 bg-neutral-10 border-t border-neutral-100 shrink-0">
        <div class="flex items-end gap-2 px-3 py-2 bg-neutral-50 border border-neutral-100 rounded-xl">
          <button
            v-if="sessions.length > 0"
            @click="showSessionPicker = true"
            title="Chat history"
            class="shrink-0 text-neutral-400 hover:text-neutral-600 transition-colors mb-0.5"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><path stroke-linecap="round" d="M12 6v6l4 2"/>
            </svg>
          </button>
          <textarea
            v-model="messageInput"
            @keydown.meta.enter.prevent="sendMessage"
            @keydown.ctrl.enter.prevent="sendMessage"
            rows="1"
            placeholder="Ask anything..."
            class="flex-1 bg-transparent text-sm text-neutral-800 placeholder-neutral-400 focus:outline-none resize-none max-h-40 leading-5"
            style="field-sizing: content"
          />
          <button
            v-if="isGenerating"
            @click="cancelGeneration"
            class="shrink-0 text-neutral-500 hover:text-red-500 transition-colors mb-0.5"
            title="Stop generating"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2"/>
            </svg>
          </button>
          <button
            v-else
            @click="sendMessage"
            :disabled="!canSend"
            class="shrink-0 text-neutral-500 hover:text-primary-500 disabled:opacity-40 transition-colors mb-0.5"
            title="Send (⌘↵)"
          >
            <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path stroke-linecap="round" stroke-linejoin="round" d="M22 2L11 13M22 2L15 22l-4-9-9-4 20-7z"/>
            </svg>
          </button>
        </div>
      </div>

    </div>
  </DockedPanel>
</template>

<style scoped>
.animate-message-slide-in {
  animation: messageSlideIn 0.2s ease-out;
}

@keyframes messageSlideIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.overflow-y-auto::-webkit-scrollbar {
  width: 4px;
}

.overflow-y-auto::-webkit-scrollbar-track {
  background: transparent;
}

.overflow-y-auto::-webkit-scrollbar-thumb {
  background: var(--color-neutral-200);
  border-radius: 4px;
}

details[open] .details-chevron { transform: rotate(90deg); }

.markdown-content p { margin: 0.25rem 0; }
.markdown-content h1, .markdown-content h2, .markdown-content h3, .markdown-content h4 { margin: 0.5rem 0; font-weight: 600; }
.markdown-content ul, .markdown-content ol { margin: 0.25rem 0; padding-left: 1.25rem; }
.markdown-content li { margin: 0.125rem 0; }
.markdown-content code {
  background: var(--color-primary-50);
  color: var(--color-primary-700);
  padding: 0.125rem 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.875em;
}
.markdown-content pre {
  background: var(--color-neutral-900);
  color: var(--color-neutral-100);
  padding: 0.75rem;
  border-radius: 0.5rem;
  overflow-x: auto;
  margin: 0.5rem 0;
}
.markdown-content pre code { background: transparent; color: inherit; padding: 0; }
.markdown-content a { color: var(--color-primary-600); text-decoration: underline; }
.markdown-content blockquote { border-left: 3px solid var(--color-neutral-200); padding-left: 0.75rem; margin: 0.5rem 0; color: var(--color-neutral-500); }
.markdown-content strong { font-weight: 600; }
.markdown-content hr { margin: 0.75rem 0; border-color: var(--color-neutral-200); }
</style>
