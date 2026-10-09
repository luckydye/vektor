import { For, Index, Show } from "solid-js";
import type { AIChatSessionListEntry } from "#api/client.ts";
import { formatAbsoluteDate } from "#utils/dateFormat.ts";
import { AskAgentInput } from "./AskAgentInput.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  viewAllLabel: string;
  placeholder: string;
  emptyLabel: string;
  lang: string;
  spaceId: string;
  disabled: boolean;
  /** `undefined` while loading. */
  sessions: AIChatSessionListEntry[] | undefined;
  rows: number;
  onAsk: (message: string) => void;
  onResume: (session: AIChatSessionListEntry) => void;
  onViewAll: () => void;
}

export function AgentSection(props: Props) {
  return (
    <section>
      <div class="divide-y divide-neutral-100 overflow-hidden rounded-lg border border-neutral-100 bg-neutral-10">
        <AskAgentInput
          spaceId={props.spaceId}
          disabled={props.disabled}
          placeholder={props.placeholder}
          onSubmit={(message) => props.onAsk(message)}
        />

        {/* Fixed height so loading and empty states never shift the page. */}
        <div class="divide-y divide-neutral-100 bg-neutral-50" style={{ height: `${props.rows * 2.5}rem` }}>
          <Show
            when={props.sessions}
            fallback={
              <Index each={Array.from({ length: props.rows })}>
                {() => (
                  <div class="flex h-10 items-center justify-between gap-4 px-3.5">
                    <div class="h-3.5 w-1/2 animate-pulse rounded-sm bg-skeleton" />
                    <div class="h-3 w-16 animate-pulse rounded-sm bg-skeleton" />
                  </div>
                )}
              </Index>
            }
          >
            {(sessions) => (
              <Show
                when={sessions().length > 0}
                fallback={
                  <p class="flex h-10 items-center px-3.5 text-neutral-400 text-size-small">
                    {props.emptyLabel}
                  </p>
                }
              >
                <For each={sessions()}>
                  {(session) => (
                    <button
                      type="button"
                      onClick={() => props.onResume(session)}
                      class="flex h-10 w-full items-center gap-4 px-3.5 text-left transition-colors hover:bg-neutral-100"
                    >
                      <span class="min-w-0 flex-1 truncate text-neutral-600 text-size-small">
                        {session.title}
                      </span>
                      <span class="shrink-0 text-neutral-400 text-size-extra-small">
                        {formatAbsoluteDate(session.updatedAt, props.lang)}
                      </span>
                      <Icon class="h-4 w-4 shrink-0 text-neutral-400" name="chevron-right-thin" />
                    </button>
                  )}
                </For>
              </Show>
            )}
          </Show>
        </div>

        <button
          type="button"
          onClick={() => props.onViewAll()}
          class="flex h-10 w-full items-center gap-4 bg-neutral-50 px-3.5 text-left transition-colors hover:bg-neutral-100"
        >
          <span class="min-w-0 flex-1 text-neutral-400 text-size-small">{props.viewAllLabel}</span>
          <Icon class="h-4 w-4 shrink-0 text-neutral-400" name="chevron-right-thin" />
        </button>
      </div>
    </section>
  );
}
