import { For, Show } from "solid-js";
import { twMerge } from "tailwind-merge";
import type { ChatSession } from "#api/client.ts";
import { BotAvatar } from "./AIChatMessages.tsx";
import { Icon } from "./Icon.tsx";
import { SectionLabel } from "./SectionLabel.tsx";

interface Props {
  channels: ChatSession[];
  activeId: string | null;
  hrefOf: (channelId: string) => string;
  /** Editors may create bots. */
  canCreate: boolean;
  onCreate: () => void;
}

/** The row shape `MenuLink` draws, so bots line up with the rest of the nav. */
const rowClass =
  "button-with-icon flex min-h-[32px] w-full cursor-pointer items-center overflow-hidden whitespace-nowrap rounded-md px-3xs font-normal text-neutral-800 text-size-normal max-md:min-h-11";

/** The sidebar's bot channels, and the way to create one. */
export function BotChannelList(props: Props) {
  return (
    <Show when={props.channels.length > 0 || props.canCreate}>
      <div class="flex flex-none flex-col gap-0.5 px-3xs @max-xs:px-3xs">
        <SectionLabel text="Bots" />
        <For each={props.channels}>
          {(channel) => (
            <a
              href={props.hrefOf(channel.id)}
              data-tooltip={channel.title}
              data-tooltip-pos="right"
              class={twMerge(
                rowClass,
                props.activeId === channel.id
                  ? "bg-primary-100 text-primary-700"
                  : "hover:bg-primary-50 active:bg-primary-100",
              )}
            >
              {/* The size sits in here: twMerge reads it as clashing with the active text colour. */}
              <div class="flex min-w-0 flex-1 items-center text-size-normal">
                <BotAvatar
                  avatar={channel.avatar}
                  class="h-[1.35em] w-[1.35em] rounded-full text-size-small"
                />
                <span class="@max-xs:hidden ml-3xs min-w-0 flex-1 truncate">
                  {channel.title}
                </span>
              </div>
              <Show when={channel.running}>
                <span
                  class="@max-xs:hidden h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-primary-500"
                  title="Answering"
                />
              </Show>
            </a>
          )}
        </For>
        {/* Once there are bots, the "Create bot" action makes more. */}
        <Show when={props.canCreate && props.channels.length === 0}>
          <button
            type="button"
            data-tooltip="Create bot"
            data-tooltip-pos="right"
            class={`${rowClass} text-neutral-500 hover:bg-primary-50 active:bg-primary-100`}
            onClick={() => props.onCreate()}
          >
            <Icon name="add" />
            <span class="@max-xs:hidden">Create bot</span>
          </button>
        </Show>
      </div>
    </Show>
  );
}
