<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from "vue";
import { Actions } from "../utils/actions.js";
import { useSpace } from "../composeables/useSpace.ts";
import { Icon } from "~/src/components";

const props = defineProps({
  documentId: {
    type: String,
    required: true,
  },
});

const { currentSpaceId } = useSpace();
const isOpen = ref(false);
const messageInput = ref("");
const messages = ref<Array<{ role: 'user' | 'assistant' | 'system', content: string, timestamp: number }>>([]);
const messagesContainer = ref<HTMLElement | null>(null);
const session = ref<any>(null);
const isAvailable = ref(false);
const isGenerating = ref(false);

// Register action to toggle the AI chat panel
Actions.register("ai-chat:toggle", {
  title: "AI Chat",
  icon: () => "sparkles",
  description: "Open AI chat to ask questions about this document",
  group: "document",
  run: async () => {
    isOpen.value = !isOpen.value;
  },
});

// Watch isOpen and emit events, also add body class for layout adjustments
watch(isOpen, (newValue) => {
  if (newValue) {
    document.body.classList.add('ai-chat-open');
  } else {
    document.body.classList.remove('ai-chat-open');
  }

  window.dispatchEvent(new CustomEvent('ai-chat:toggled', {
    detail: { isOpen: newValue },
    bubbles: true,
    composed: true,
  }));
});

function getDocumentContent(): string {
  try {
    const documentView = document.querySelector('document-view') as any;
    if (documentView?.editor) {
      const editor = documentView.editor;
      // Get HTML content from the editor
      const html = editor.getHTML();
      return html || '';
    }

    // Fallback: try to get content from the shadow DOM
    const shadowRoot = documentView?.shadowRoot;
    if (shadowRoot) {
      const contentDiv = shadowRoot.querySelector('[part="content"]');
      return contentDiv?.textContent || '';
    }

    return '';
  } catch (error) {
    console.error('Error getting document content:', error);
    return '';
  }
}

async function sendMessage() {
  if (!messageInput.value.trim() || isGenerating.value || !isAvailable.value) return;

  const message = messageInput.value.trim();

  // Add user message
  messages.value.push({
    role: 'user',
    content: message,
    timestamp: Date.now(),
  });

  messageInput.value = '';
  scrollToBottom();

  // Start generating AI response
  isGenerating.value = true;

  // Add placeholder message for streaming response
  const assistantMessageIndex = messages.value.length;
  messages.value.push({
    role: 'assistant',
    content: '',
    timestamp: Date.now(),
  });

  try {
    // Create session if not exists
    if (!session.value) {
      // @ts-expect-error
      session.value = await LanguageModel?.create({
        initialPrompts: [
          {
            role: "system",
            content: `You are a helpful AI assistant integrated into a wiki/documentation system.
You help users understand and work with their documents. Be concise, accurate, and helpful.

IMPORTANT: You have access to a tool to get the current document content. When a user asks questions about "this document", "the page", "the current content", or anything that requires seeing the document, you MUST use the tool.

To request the document content, include in your response:
[REQUEST_DOCUMENT_CONTENT]

When you see [DOCUMENT_CONTENT] in the conversation, that's the document content provided to you.`,
          },
        ],
      });
    }

    if (!session.value) {
      throw new Error("AI session could not be created");
    }

    // Stream the response
    const stream = session.value.promptStreaming(message);

    for await (const chunk of stream) {
      messages.value[assistantMessageIndex].content += chunk;

      // Check if AI is requesting document content
      if (messages.value[assistantMessageIndex].content.includes('[REQUEST_DOCUMENT_CONTENT]')) {
        // Remove the request marker
        messages.value[assistantMessageIndex].content = messages.value[assistantMessageIndex].content.replace('[REQUEST_DOCUMENT_CONTENT]', '').trim();

        // Get document content
        const docContent = getDocumentContent();

        // Add visual indicator that document content was provided
        messages.value.push({
          role: 'system',
          content: '📄 Document content provided to AI',
          timestamp: Date.now(),
        });
        scrollToBottom();

        // Add system message with document content
        const followUpPrompt = `[DOCUMENT_CONTENT]\n${docContent}\n\nNow answer the user's question based on this document content.`;

        // Create a new message for the AI's response after receiving context
        const contextResponseIndex = messages.value.length;
        messages.value.push({
          role: 'assistant',
          content: '',
          timestamp: Date.now(),
        });

        // Continue the conversation with document content
        const followUpStream = session.value.promptStreaming(followUpPrompt);

        for await (const followUpChunk of followUpStream) {
          messages.value[contextResponseIndex].content += followUpChunk;
          // Remove any markers that might appear in the response
          messages.value[contextResponseIndex].content = messages.value[contextResponseIndex].content
            .replace('[DOCUMENT_CONTENT]', '')
            .replace('[END_DOCUMENT_CONTENT]', '');
          scrollToBottom();
        }

        break; // Exit the first stream loop
      }
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "AI generation failed";
    messages.value[assistantMessageIndex].content = `Sorry, I encountered an error: ${errorMessage}`;
    console.error('AI Error:', error);
  } finally {
    isGenerating.value = false;
    scrollToBottom();
  }
}

function scrollToBottom() {
  setTimeout(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  }, 50);
}

async function checkAvailability() {
  try {
    // @ts-expect-error
    const availability = await LanguageModel?.availability();

    if (availability !== "unavailable") {
      isAvailable.value = true;
    } else {
      isAvailable.value = false;
    }
  } catch {
    isAvailable.value = false;
  }
}

onMounted(async () => {
  // Check AI availability
  await checkAvailability();

  // Add welcome message
  if (isAvailable.value) {
    messages.value.push({
      role: 'assistant',
      content: 'Hello! I\'m here to help you with this document. Ask me anything!',
      timestamp: Date.now(),
    });
  } else {
    messages.value.push({
      role: 'assistant',
      content: 'AI is not available in this browser. Please use Chrome with the Prompt API enabled.',
      timestamp: Date.now(),
    });
  }
});

onUnmounted(() => {
  // Clean up AI session
  if (session.value) {
    session.value.destroy?.();
  }

  // Clean up body class
  document.body.classList.remove('ai-chat-open');

  // Unregister the action
  Actions.unregister("ai-chat:toggle");
});
</script>

<template>
  <aside
    v-if="isOpen"
    class="fixed top-0 right-0 bottom-0 w-full md:w-[420px] lg:w-[480px] bg-neutral-10 border-l border-neutral-200 flex flex-col z-40 animate-slide-in"
  >
    <!-- Header -->
    <div class="flex items-center justify-between px-4 py-3 border-b border-neutral-200 bg-white">
      <div class="flex items-center gap-2">
        <Icon name="sparkles" class="text-primary-600" />
        <h2 class="text-lg font-semibold text-neutral-900">
          AI Chat
        </h2>
      </div>
      <button
        @click="isOpen = false"
        class="p-2 text-neutral-600 hover:text-neutral-900 hover:bg-neutral-100 rounded transition-colors"
        title="Close"
      >
        <svg
          class="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="2"
            d="M6 18L18 6M6 6l12 12"
          />
        </svg>
      </button>
    </div>

    <!-- Messages Area -->
    <div
      ref="messagesContainer"
      class="flex-1 overflow-y-auto px-4 py-4 space-y-4 bg-neutral-10"
    >
      <div
        v-for="(message, index) in messages"
        :key="index"
        :class="[
          'animate-message-slide-in',
          message.role === 'system' ? 'flex justify-center' : 'flex',
          message.role === 'user' ? 'justify-end' : message.role === 'assistant' ? 'justify-start' : ''
        ]"
      >
        <!-- System message (tool call indicator) -->
        <div
          v-if="message.role === 'system'"
          class="px-3 py-1.5 bg-neutral-100 text-neutral-600 rounded-full text-xs font-medium border border-neutral-200"
        >
          {{ message.content }}
        </div>

        <!-- User/Assistant messages -->
        <div
          v-else
          :class="[
            'max-w-[80%] rounded-lg px-4 py-2',
            message.role === 'user'
              ? 'bg-primary-600 text-white'
              : 'bg-white text-neutral-900 border border-neutral-200'
          ]"
        >
          <p class="text-sm whitespace-pre-wrap">{{ message.content }}</p>
        </div>
      </div>
    </div>

    <!-- Input Area -->
    <div class="border-t border-neutral-200 p-4 bg-white">
      <div class="flex gap-2">
        <input
          v-model="messageInput"
          @keypress.enter="sendMessage"
          type="text"
          placeholder="Ask a question about this document..."
          class="flex-1 px-3 py-2 text-sm border border-neutral-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
        />
        <button
          @click="sendMessage"
          :disabled="!messageInput.trim() || !isAvailable || isGenerating"
          :class="[
            'px-4 py-2 text-white rounded-md transition-colors flex items-center gap-2',
            isAvailable && !isGenerating
              ? 'bg-primary-600 hover:bg-primary-700'
              : 'bg-neutral-400 cursor-not-allowed',
            (!messageInput.trim() || !isAvailable || isGenerating) && 'opacity-50'
          ]"
          :title="!isAvailable ? 'AI is not available in this browser' : ''"
        >
          <svg
            v-if="!isGenerating"
            class="w-4 h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
            />
          </svg>
          <svg
            v-else
            class="w-4 h-4 animate-spin"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          <span class="text-sm">{{ isGenerating ? 'Generating...' : 'Send' }}</span>
        </button>
      </div>
      <p class="text-xs text-neutral-500 mt-2">
        <span v-if="isAvailable">✨ Powered by Chrome's built-in AI</span>
        <span v-else>⚠️ AI is not available. Enable Chrome's Prompt API in chrome://flags</span>
      </p>
    </div>
  </aside>
</template>

<style scoped>
.animate-slide-in {
  animation: slideIn 300ms ease;
}

@keyframes slideIn {
  from {
    transform: translateX(100%);
  }
  to {
    transform: translateX(0);
  }
}

.animate-message-slide-in {
  animation: messageSlideIn 0.3s ease-out;
}

@keyframes messageSlideIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* Scrollbar styling */
:deep(.overflow-y-auto)::-webkit-scrollbar {
  width: 8px;
}

:deep(.overflow-y-auto)::-webkit-scrollbar-track {
  background: #f3f4f6;
}

:deep(.overflow-y-auto)::-webkit-scrollbar-thumb {
  background: #d1d5db;
  border-radius: 4px;
}

:deep(.overflow-y-auto)::-webkit-scrollbar-thumb:hover {
  background: #9ca3af;
}
</style>
