import { createEffect, createMemo, on, onCleanup, Show } from "solid-js";
import type { AIChatSessionListEntry } from "#api/client.ts";
import { useAgentChat } from "#composeables/useAgentChat.ts";
import { useDockedWindows } from "#composeables/useDockedWindows.ts";
import { useAgentAvailable } from "#composeables/useIntegrationAIModel.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import { Actions } from "#utils/actions.ts";
import { registerScopedAction } from "#utils/scopedAction.ts";
import { AIChatConversation } from "./AIChatConversation.tsx";
import { DockedPanel } from "./DockedPanel.tsx";
import { IconButton } from "./IconButton.tsx";

interface Props {
  documentId?: string;
}

export function AIChatPanel(props: Props) {
  const t = useTranslation();
  const {
    open,
    toggle: toggleWindow,
    close: closeWindow,
    windows: dockedWindows,
  } = useDockedWindows();
  const isOpen = createMemo(() => dockedWindows().get("ai-chat")?.open ?? false);
  const chat = useAgentChat({
    documentId: () => props.documentId ?? "",
    isActive: isOpen,
  });
  const {
    sessions,
    showSessionPicker,
    setShowSessionPicker,
    isGenerating,
    startNewChat,
    resumeSession,
    currentSessionId,
    currentSpaceId,
    setMessageInput,
    sendMessage,
  } = chat;

  const agentAvailable = useAgentAvailable();
  const isAgentConfigured = createMemo(() => agentAvailable() === true);

  onCleanup(
    Actions.subscribe("ai-chat:ask", (event) => {
      open("ai-chat", { side: "right", width: 380 });
      setMessageInput(event.detail as string);
      // A running turn belongs to the current session, so the question waits in the input.
      if (isGenerating()) return;
      startNewChat();
      void sendMessage();
    }),
  );
  onCleanup(
    Actions.subscribe("ai-chat:resume", (event) => {
      open("ai-chat", { side: "right", width: 380 });
      void resumeSession(event.detail as AIChatSessionListEntry);
    }),
  );
  onCleanup(
    Actions.subscribe("ai-chat:sessions", () => {
      open("ai-chat", { side: "right", width: 380 });
      setShowSessionPicker(true);
    }),
  );

  createEffect(
    on(isAgentConfigured, (configured) => {
      if (!configured) {
        if (isOpen()) closeWindow("ai-chat");
        return;
      }
      registerScopedAction("ai-chat:toggle", {
        title: t("AI Chat"),
        icon: () => "agent-chat",
        description: t("Open AI chat to ask questions about this document"),
        group: "document:view",
        order: 20,
        run: async () => {
          toggleWindow("ai-chat", { side: "right", width: 380 });
        },
      });
    }),
  );

  const contextUrl = () => {
    const spaceId = currentSpaceId();
    const sessionId = currentSessionId();
    if (!spaceId || !sessionId) return null;
    return `/api/v1/spaces/${encodeURIComponent(spaceId)}/ai-chat/sessions/${encodeURIComponent(sessionId)}/context`;
  };

  return (
    <DockedPanel
      id="ai-chat"
      title="Assistant"
      defaultSide="right"
      defaultWidth={380}
      swipeToOpen={isAgentConfigured()}
      actions={
        <>
          <Show when={sessions().length > 0}>
            <IconButton
              icon="activity"
              label="Chat history"
              tooltipPos="bottom"
              class={`pointer-coarse:h-9 pointer-coarse:w-9 ${showSessionPicker() ? "bg-neutral-100 text-neutral-900" : ""}`}
              onClick={() => setShowSessionPicker(!showSessionPicker())}
            />
          </Show>
          <Show when={contextUrl()}>
            {(url) => (
              <IconButton
                icon="source-code"
                label="Model context of the latest turn"
                tooltipPos="bottom"
                class="pointer-coarse:h-9 pointer-coarse:w-9"
                onClick={() => window.open(url(), "_blank", "noopener,noreferrer")}
              />
            )}
          </Show>
          <Show when={!showSessionPicker()}>
            <IconButton
              icon="edit-entry"
              label="New chat"
              tooltipPos="bottom"
              class="pointer-coarse:h-9 pointer-coarse:w-9"
              disabled={isGenerating()}
              onClick={startNewChat}
            />
          </Show>
          <span class="mx-1 h-4 w-px bg-neutral-200" />
        </>
      }
    >
      <AIChatConversation chat={chat} />
    </DockedPanel>
  );
}
