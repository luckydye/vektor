import { Index, Show } from "solid-js";
import { memberCountLabel } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";
import { SpaceLogo } from "./SpaceLogo.tsx";
import "@atrium-ui/elements/popover";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";

export interface SelectorSpace {
  id: string;
  name: string;
  members?: number;
  color?: string;
  logoSvg?: string;
  pinned?: boolean;
}

interface Props {
  /**
   * The spaces to list, already chosen by `spaceSelectorSlots` — the dropdown
   * shows what it is given and links to the overview for the rest.
   */
  spaces?: SelectorSpace[];
  /** The space the trigger names, which need not be one of the listed ones. */
  current?: SelectorSpace | null;
  allSpacesHref?: string;
  canCreateSpaces?: boolean;
  /** Whether the current space is one the viewer may leave. */
  canLeave?: boolean;
  loading?: boolean;
  onSelect?: (space: SelectorSpace) => void;
  onCreate?: () => void;
  onLeave?: () => void;
}

function dismissPopover(target: EventTarget | null) {
  (target as Element | null)?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

export function SpaceSelector(props: Props) {
  const t = useTranslation();
  const lang = useLocale();

  return (
    <div class="flex w-full gap-4">
      <Show
        when={!props.loading}
        fallback={
          <div class="flex w-full items-start gap-3xs px-4xs py-4xs">
            <div class="aspect-square w-[2.375rem] flex-none animate-pulse rounded-md bg-skeleton-strong" />
            <div class="flex flex-1 flex-col gap-1">
              <div class="h-4 w-25 animate-pulse rounded-sm bg-skeleton-strong" />
              <div class="h-3 w-16 animate-pulse rounded-sm bg-skeleton" />
            </div>
          </div>
        }
      >
        <a-popover-trigger class="group relative z-10 block w-full overflow-hidden">
          <button
            type="button"
            slot="trigger"
            class="w-full"
            attr:aria-label={t("Select Space")}
          >
            <div class="flex items-center gap-3xs rounded-md px-4xs py-4xs transition-colors hover:bg-primary-100 group-[[opened]]:bg-primary-50">
              <div class="flex w-full cursor-pointer gap-3xs">
                <div
                  class="flex aspect-square w-[2.375rem] flex-none items-center justify-center overflow-hidden rounded-md"
                  classList={{ "bg-primary-500": !props.current?.logoSvg }}
                  // `background-color`, not the `background` shorthand: the
                  // shorthand also accepts `url()`, which turns a stored brand
                  // colour into a request to whatever host it names. A space
                  // with a mark of its own keeps a bare tile behind it.
                  style={
                    props.current?.logoSvg
                      ? undefined
                      : { "background-color": props.current?.color }
                  }
                >
                  <SpaceLogo
                    logoSvg={props.current?.logoSvg}
                    class="h-full w-full object-cover"
                  />
                </div>

                <div class="relative h-9 flex-1 text-left">
                  <div class="left-0 h-full w-full">
                    <div class="overflow-hidden text-ellipsis whitespace-nowrap font-normal text-foreground text-size-medium leading-[1.35em]">
                      {props.current?.name || t("Select Space")}
                    </div>
                    <div class="overflow-hidden text-ellipsis whitespace-nowrap text-neutral-600 text-size-normal leading-[1.35em]">
                      {memberCountLabel(props.current?.members, lang)}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </button>

          {/* A bottom sheet on phones, via `.popover-sheet`, with rows sized for touch. */}
          <a-popover class="group popover-sheet" placements="bottom-start">
            <div class="w-max min-w-(--trigger-width) opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
              <div class="max-h-[500px] origin-top scale-95 overflow-y-auto rounded-lg border border-neutral-100 bg-neutral-50 shadow-xl transition-all duration-150 group-[[enabled]]:scale-100">
                <div class="flex flex-col gap-[4px] p-[4px]">
                  <Index each={props.spaces}>
                    {(space) => (
                      <button
                        type="button"
                        onClick={(event) => {
                          props.onSelect?.(space());
                          dismissPopover(event.target);
                        }}
                        class="flex w-full items-center gap-2.5 rounded-md px-4xs py-4xs text-left transition-colors hover:bg-black/6 active:bg-black/10 max-md:min-h-13 max-md:gap-3xs dark:hover:bg-white/10 dark:active:bg-white/16"
                        classList={{
                          "bg-primary-100": space().id === props.current?.id,
                        }}
                      >
                        <div
                          class="flex h-6 w-6 items-center justify-center overflow-hidden rounded-sm max-md:h-8 max-md:w-8 max-md:rounded-md"
                          classList={{ "bg-primary-500": !space().logoSvg }}
                          style={
                            space().logoSvg
                              ? undefined
                              : { "background-color": space().color || "#6366f1" }
                          }
                        >
                          <SpaceLogo
                            logoSvg={space().logoSvg}
                            class="block object-contain"
                            fallbackClass="text-white [&>svg]:w-4 [&>svg]:h-4 [&>svg]:object-contain"
                          />
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="truncate font-medium text-foreground text-size-small max-md:text-size-large">
                            {space().name}
                          </div>
                        </div>
                        <Show when={space().pinned}>
                          <Icon
                            name="pin-to-home"
                            class="h-3.5 w-3.5 flex-none text-neutral-500"
                          />
                        </Show>
                      </button>
                    )}
                  </Index>

                  <div class="mt-[4px] flex flex-col gap-[4px] border-neutral-100 border-t pt-[4px]">
                    <Show when={props.allSpacesHref}>
                      {(href) => (
                        <a
                          href={href()}
                          class="flex w-full items-center gap-2.5 rounded-md px-3xs py-4xs text-neutral-500 transition-colors hover:bg-black/6 active:bg-black/10 max-md:min-h-12 dark:hover:bg-white/10 dark:active:bg-white/16"
                        >
                          <Icon name="grid-grid" />
                          <span class="font-medium text-size-small leading-none max-md:text-size-large">
                            {t("All spaces")}
                          </span>
                        </a>
                      )}
                    </Show>

                    <Show when={props.canCreateSpaces}>
                      <button
                        type="button"
                        onClick={(event) => {
                          props.onCreate?.();
                          dismissPopover(event.target);
                        }}
                        class="flex w-full items-center gap-2.5 rounded-md px-3xs py-4xs text-neutral-500 transition-colors hover:bg-black/6 active:bg-black/10 max-md:min-h-12 dark:hover:bg-white/10 dark:active:bg-white/16"
                      >
                        <Icon name="add" />
                        <span class="font-medium text-size-small leading-none max-md:text-size-large">
                          {t("Create new Space")}
                        </span>
                      </button>
                    </Show>

                    <Show when={props.canLeave}>
                      <button
                        type="button"
                        onClick={(event) => {
                          dismissPopover(event.target);
                          props.onLeave?.();
                        }}
                        class="flex w-full items-center gap-2.5 rounded-md px-3xs py-4xs text-red-600 transition-colors hover:bg-red-50 active:bg-red-100 max-md:min-h-12 dark:hover:bg-red-950/40 dark:active:bg-red-900/40"
                      >
                        <Icon name="sign-out" />
                        <span class="font-medium text-size-small leading-none max-md:text-size-large">
                          {t("Leave space")}
                        </span>
                      </button>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </a-popover>
        </a-popover-trigger>
      </Show>
    </div>
  );
}
