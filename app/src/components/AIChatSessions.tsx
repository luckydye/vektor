import { For, Show } from "solid-js";
import type { AIChatSessionListEntry } from "#api/client.ts";
import { formatAbsoluteDate } from "#utils/dateFormat.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  sessions: AIChatSessionListEntry[];
  currentSessionId: string | null;
  showPicker: boolean;
  isGenerating: boolean;
  getSessionStatus: (session: AIChatSessionListEntry) => string;
  onUpdateShowPicker?: (value: boolean) => void;
  onNewChat?: () => void;
  onResume?: (session: AIChatSessionListEntry) => void;
  onRemove?: (session: AIChatSessionListEntry) => void;
}

export function AIChatSessions(props: Props) {
  return (
    <>
      <Show when={!props.showPicker}>
        <div class="flex shrink-0 items-center gap-3 border-neutral-100 border-b bg-neutral-10 px-3 py-4">
          <Show when={props.sessions.length > 0}>
            <button
              type="button"
              onClick={() => props.onUpdateShowPicker?.(true)}
              class="flex items-center gap-1.5 text-neutral-500 text-size-small transition-colors hover:text-neutral-700"
              title="Recent conversations"
            >
              <Icon class="h-3.5 w-3.5" name="activity" />
              History
            </button>
          </Show>
          <div class="flex-1" />
          <button
            type="button"
            onClick={() => props.onNewChat?.()}
            disabled={props.isGenerating}
            class="flex items-center gap-1 font-medium text-primary-600 text-size-small transition-colors hover:text-primary-700"
            title="New chat"
          >
            <Icon class="h-3.5 w-3.5" name="edit-entry" />
            <span>New chat</span>
          </button>
        </div>
      </Show>

      <Show when={props.showPicker}>
        <div class="flex-1 overflow-y-auto px-3 py-4">
          <div class="mb-3 flex items-center justify-between">
            <p class="font-medium text-neutral-400 text-size-extra-small uppercase tracking-wide">
              Recent conversations
            </p>
            <button
              type="button"
              onClick={() => props.onNewChat?.()}
              class="flex items-center gap-1 font-medium text-primary-600 text-size-small transition-colors hover:text-primary-700"
            >
              <Icon class="h-3.5 w-3.5" name="add" />
              New chat
            </button>
          </div>
          <div class="space-y-0.5">
            <For each={props.sessions}>
              {(session) => {
                const status = () => props.getSessionStatus(session);
                return (
                  /* biome-ignore lint/a11y/noStaticElementInteractions: the row preserves the list layout. */
                  /* biome-ignore lint/a11y/useKeyWithClickEvents: navigation is handled by the command interface. */
                  <div
                    class="group flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-neutral-100"
                    onClick={() => props.onResume?.(session)}
                  >
                    <div class="mt-0.5 shrink-0">
                      <span
                        class="block h-2 w-2 rounded-full"
                        classList={{
                          "animate-pulse bg-primary-500": status() === "generating",
                          "bg-amber-400": status() === "awaiting",
                          "bg-neutral-200":
                            status() !== "generating" && status() !== "awaiting",
                        }}
                      />
                    </div>

                    <div class="min-w-0 flex-1">
                      <p class="truncate text-neutral-800 text-size-medium">
                        {session.title}
                      </p>
                      <p class="mt-0.5 text-size-small">
                        <Show when={status() === "generating"}>
                          <span class="font-medium text-primary-500">
                            Generating response…
                          </span>
                        </Show>
                        <Show when={status() === "awaiting"}>
                          <span class="font-medium text-amber-500">
                            Awaiting response
                          </span>
                        </Show>
                        <Show when={status() !== "generating" && status() !== "awaiting"}>
                          <span class="text-neutral-400">
                            {formatAbsoluteDate(session.updatedAt)}
                          </span>
                        </Show>
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        props.onRemove?.(session);
                      }}
                      class="shrink-0 p-1 text-neutral-400 opacity-0 transition-all hover:text-red-500 group-hover:opacity-100"
                      title="Delete"
                    >
                      <Icon class="h-3.5 w-3.5" name="delete-entry" />
                    </button>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </Show>
    </>
  );
}
