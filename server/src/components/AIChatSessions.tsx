import { For, Show } from "solid-js";
import type { AIChatSessionListEntry } from "#api/client.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { formatAbsoluteDate } from "#utils/dateFormat.ts";
import { IconButton } from "./IconButton.tsx";

interface Props {
  /** The sessions to list. */
  sessions: AIChatSessionListEntry[];
  currentSessionId: string | null;
  getSessionStatus: (session: AIChatSessionListEntry) => string;
  onResume?: (session: AIChatSessionListEntry) => void;
  onRemove?: (session: AIChatSessionListEntry) => void;
}

export function AIChatSessions(props: Props) {
  const lang = useLocale();
  return (
    <div class="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <div class="sticky top-0 z-10 flex items-center justify-between bg-neutral-10 px-2.5 pt-3 pb-2">
        <p class="font-medium text-neutral-500 text-size-extra-small uppercase tracking-wide">
          Recent chats
        </p>
      </div>
      <Show when={props.sessions.length === 0}>
        <p class="px-2 py-10 text-center text-neutral-400 text-size-small">No chats yet</p>
      </Show>
      <div>
        <For each={props.sessions}>
          {(session) => {
            const status = () => props.getSessionStatus(session);
            const current = () => session.id === props.currentSessionId;
            return (
              /* biome-ignore lint/a11y/noStaticElementInteractions: the row preserves the list layout. */
              /* biome-ignore lint/a11y/useKeyWithClickEvents: navigation is handled by the command interface. */
              <div
                class="group flex cursor-pointer items-center gap-3 border-neutral-100 border-t px-2.5 py-2.5 first:border-transparent hover:border-transparent hover:bg-neutral-50 pointer-coarse:py-3 [&:hover+*]:border-transparent"
                classList={{ "bg-neutral-50": current() }}
                onClick={() => props.onResume?.(session)}
              >
                <Show when={status() === "generating" || status() === "awaiting"}>
                  <span
                    class="-ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full"
                    classList={{
                      "animate-pulse bg-primary-500": status() === "generating",
                      "bg-amber-400": status() === "awaiting",
                    }}
                  />
                </Show>
                <span class="min-w-0 flex-1 truncate text-neutral-800 text-size-small">
                  {session.title}
                </span>
                <span class="shrink-0 text-neutral-400 text-size-extra-small">
                  <Show
                    when={status() === "generating" || status() === "awaiting"}
                    fallback={formatAbsoluteDate(session.updatedAt, lang)}
                  >
                    {status() === "generating" ? "Generating…" : "Awaiting response"}
                  </Show>
                </span>
                <IconButton
                  icon="delete-entry"
                  label="Delete"
                  class="-mr-1.5 pointer-coarse:h-9 pointer-coarse:w-9 pointer-fine:opacity-0 pointer-fine:focus:opacity-100 pointer-fine:group-hover:opacity-100"
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
    </div>
  );
}
