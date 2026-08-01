import { createMemo, For, Show } from "solid-js";
import homeIcon from "#assets/icons/home.svg?raw";
import { t } from "#utils/lang.ts";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";
import "@atrium-ui/elements/popover";

interface Space {
  id: string;
  name: string;
  members?: number;
  color?: string;
  logoSvg?: string;
}

interface Props {
  spaces?: Space[];
  spaceName?: string;
  value?: string | null;
  canAccessSettings?: boolean;
  canCreateDocs?: boolean;
  loading?: boolean;
  onInput?: (value: string) => void;
  onSelect?: (space: Space) => void;
  onSettings?: () => void;
  onCreate?: (data: { name: string; slug: string; brandColor: string }) => void;
  onCreateDoc?: () => void;
}

/** Closes the popover the click came from — it listens for a bubbling `exit`. */
function dismissPopover(target: EventTarget | null) {
  (target as Element | null)?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
}

/** A space's logo: inline SVG markup, an image URL, or the house fallback. */
function SpaceLogo(props: { logoSvg?: string; class?: string; fallbackClass?: string }) {
  return (
    <Show
      when={props.logoSvg}
      fallback={<Icon class={props.fallbackClass ?? "text-white"} name="home" />}
    >
      <Show
        when={props.logoSvg?.startsWith("<")}
        fallback={<img src={props.logoSvg} alt="" class={props.class} />}
      >
        <Icon class="text-white" svg={props.logoSvg} />
      </Show>
    </Show>
  );
}

export function SpaceSelector(props: Props) {
  const currentSpace = createMemo(() => {
    if (props.value) {
      return props.spaces?.find((s) => s.id === props.value) || props.spaces?.[0] || null;
    }
    return props.spaces?.[0] || null;
  });

  const memberCountLabel = createMemo(() => {
    const count = currentSpace()?.members || 0;
    return `${count} ${count === 1 ? t("Member") : t("Members")}`;
  });

  return (
    <div class="flex w-full gap-4">
      <Show
        when={!props.loading}
        fallback={
          <div class="flex w-full items-start gap-3xs px-4xs py-4xs">
            <div class="aspect-square w-[2.375rem] flex-none animate-pulse rounded-md bg-neutral-200" />
            <div class="flex flex-1 flex-col gap-1">
              <div class="h-4 w-25 animate-pulse rounded-sm bg-neutral-200" />
              <div class="h-3 w-16 animate-pulse rounded-sm bg-neutral-100" />
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
                  class="flex aspect-square w-[2.375rem] flex-none items-center justify-center overflow-hidden rounded-md bg-primary-500"
                  style={{ background: currentSpace()?.color }}
                >
                  <SpaceLogo
                    logoSvg={currentSpace()?.logoSvg}
                    class="h-full w-full object-cover"
                  />
                </div>

                <div class="relative h-9 flex-1 text-left">
                  <div class="left-0 h-full w-full">
                    <div class="overflow-hidden text-ellipsis whitespace-nowrap font-normal text-foreground text-size-medium leading-[1.35em]">
                      {currentSpace()?.name || props.spaceName || t("Select Space")}
                    </div>
                    <div class="overflow-hidden text-ellipsis whitespace-nowrap text-neutral-600 text-size-normal leading-[1.35em]">
                      {memberCountLabel()}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </button>

          <a-popover class="group" placements="bottom-start">
            <div class="w-max min-w-(--trigger-width) opacity-0 transition-opacity duration-100 group-[[enabled]]:opacity-100">
              <div class="max-h-[500px] origin-top scale-95 overflow-y-auto rounded-lg border border-neutral-100 bg-neutral-50 shadow-xl transition-all duration-150 group-[[enabled]]:scale-100">
                <div class="flex flex-col gap-[4px] p-[4px]">
                  <For each={props.spaces}>
                    {(space) => (
                      <button
                        type="button"
                        onClick={(event) => {
                          props.onInput?.(space.id);
                          props.onSelect?.(space);
                          dismissPopover(event.target);
                        }}
                        class="flex w-full items-center gap-2.5 rounded-md px-4xs py-4xs text-left transition-colors hover:bg-neutral-100"
                        classList={{ "bg-primary-100": space.id === props.value }}
                      >
                        <div
                          class="flex h-6 w-6 items-center justify-center overflow-hidden rounded-sm"
                          style={{ background: space.color || "#6366f1" }}
                        >
                          <SpaceLogo
                            logoSvg={space.logoSvg}
                            class="block object-contain"
                            fallbackClass="text-white [&>svg]:w-4 [&>svg]:h-4 [&>svg]:object-contain"
                          />
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="truncate font-medium text-foreground text-size-small">
                            {space.name}
                          </div>
                        </div>
                      </button>
                    )}
                  </For>

                  <div class="mt-[4px] border-neutral-100 border-t pt-[4px]">
                    <button
                      type="button"
                      onClick={(event) => {
                        props.onCreate?.({ name: "", slug: "", brandColor: "" });
                        dismissPopover(event.target);
                      }}
                      class="flex w-full items-center gap-2.5 rounded-md px-3xs py-4xs text-neutral-500 transition-colors hover:bg-neutral-100"
                    >
                      <Icon name="add" />
                      <span class="font-medium text-size-small leading-none">
                        {t("Create new Space")}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </a-popover>
        </a-popover-trigger>
      </Show>

      <div class="flex @max-sm:hidden flex-none items-center gap-2xs py-5xs pr-4xs">
        <Show when={props.canCreateDocs}>
          <Button
            variant="secondary"
            ariaLabel={t("New document")}
            onClick={(event) => {
              event.stopPropagation();
              props.onCreateDoc?.();
            }}
            class="px-5xs"
          >
            <Icon name="new-document" />
          </Button>
        </Show>
      </div>
    </div>
  );
}
