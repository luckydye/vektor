import { For, Show } from "solid-js";
import type { AIChatSessionListEntry } from "#api/client.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { formatAbsoluteDate } from "#utils/dateFormat.ts";
import { IconButton } from "./IconButton.tsx";

interface Props {
  /** The sessions to list, after the job-session filter. */
  sessions: AIChatSessionListEntry[];
  /** Whether sessions opened by jobs, such as workflow runs, are listed. */
  showJobSessions: boolean;
  onUpdateShowJobSessions?: (value: boolean) => void;
  currentSessionId: string | null;
  getSessionStatus: (session: AIChatSessionListEntry) => string;
  onResume?: (session: AIChatSessionListEntry) => void;
  onRemove?: (session: AIChatSessionListEntry) => void;
}

export function AIChatSessions(props: Props) {
  const lang = useLocale();
  return (
    <div class="flex-1 overflow-y-auto px-2 py-3">
      <div class="mb-1 flex items-center justify-between px-2 py-1">
        <p class="font-medium text-neutral-500 text-size-extra-small">Recent chats</p>
        <label class="flex items-center gap-1.5 text-neutral-500 text-size-extra-small">
          <input
            type="checkbox"
            checked={props.showJobSessions}
            onChange={(event) => props.onUpdateShowJobSessions?.(event.currentTarget.checked)}
          />
          Workflows
        </label>
      </div>
      <Show when={props.sessions.length === 0}>
        <p class="px-2 py-6 text-center text-neutral-400 text-size-small">No chats yet</p>
      </Show>
      <For each={props.sessions}>
        {(session) => {
          const status = () => props.getSessionStatus(session);
          return (
            /* biome-ignore lint/a11y/noStaticElementInteractions: the row preserves the list layout. */
            /* biome-ignore lint/a11y/useKeyWithClickEvents: navigation is handled by the command interface. */
            <div
              class="group flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 pointer-coarse:py-2.5 transition-colors hover:bg-neutral-100"
              classList={{ "bg-neutral-100": session.id === props.currentSessionId }}
              onClick={() => props.onResume?.(session)}
            >
              <div class="min-w-0 flex-1">
                <p class="truncate text-neutral-800 text-size-small">{session.title}</p>
                <p class="mt-0.5 flex items-center gap-1.5 text-neutral-400 text-size-extra-small">
                  <Show
                    when={status() === "generating" || status() === "awaiting"}
                    fallback={formatAbsoluteDate(session.updatedAt, lang)}
                  >
                    <span
                      class="h-1.5 w-1.5 rounded-full"
                      classList={{
                        "animate-pulse bg-primary-500": status() === "generating",
                        "bg-amber-400": status() === "awaiting",
                      }}
                    />
                    {status() === "generating" ? "Generating…" : "Awaiting response"}
                  </Show>
                </p>
              </div>
              <IconButton
                icon="delete-entry"
                label="Delete"
                class="pointer-coarse:h-9 pointer-coarse:w-9 pointer-fine:opacity-0 pointer-fine:focus:opacity-100 pointer-fine:group-hover:opacity-100"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onRemove?.(session);
                }}
              />
            </div>
          );
        }}
      </For>
    </div>
  );
}
