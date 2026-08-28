import { Show } from "solid-js";
import "@atrium-ui/elements/color-picker";
import "@atrium-ui/elements/popover";
import { Button } from "./Button.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  name: string;
  slug: string;
  brandColor: string;
  logo: string;
  description?: string;
  onUpdateBrandColor?: (value: string) => void;
  onLogoUpload?: (event: Event) => void;
  onRemoveLogo?: () => void;
}

export function SpaceProfileCard(props: Props) {
  return (
    <div class="overflow-hidden rounded-xl border border-neutral-200">
      <a-popover-trigger showdelay="0" hidedelay="100" class="block">
        <div
          slot="trigger"
          class="group relative h-24 w-full cursor-pointer transition-colors duration-300"
          style={{ "background-color": props.brandColor }}
          title="Change color"
        >
          <div class="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
            <span class="font-medium text-size-extra-small text-white drop-shadow">
              Change color
            </span>
          </div>
        </div>
        <a-popover class="group" placements="bottom-start">
          <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
            <div class="origin-top-left scale-95 rounded-lg border border-neutral-100 bg-background p-2 shadow-large transition-all duration-150 group-[&[enabled]]:scale-100">
              <a-color-picker
                class="w-[220px]"
                attr:value={props.brandColor}
                on:change={(event: Event) =>
                  props.onUpdateBrandColor?.(
                    (event.target as HTMLElement & { value: string }).value,
                  )
                }
              />
            </div>
          </div>
        </a-popover>
      </a-popover-trigger>

      <div class="px-3 pb-3">
        <div class="-mt-8 mb-2.5 flex items-end gap-1.5">
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the file input below is the control. */}
          <label
            class="group relative flex h-16 w-16 cursor-pointer items-center justify-center overflow-hidden rounded-xl border-2 border-white shadow-sm"
            style={{ "background-color": props.brandColor }}
            title="Change logo"
          >
            <input
              type="file"
              accept="image/svg+xml,image/png,image/jpeg"
              class="sr-only"
              onChange={(event) => props.onLogoUpload?.(event)}
            />
            <Show
              when={props.logo}
              fallback={
                <span class="select-none font-bold text-sm text-white leading-none">
                  {(props.name || "?")[0].toUpperCase()}
                </span>
              }
            >
              <img src={props.logo} alt="" class="h-full w-full object-cover" />
            </Show>
            <div class="absolute inset-0 flex items-center justify-center rounded-lg bg-black/30 opacity-0 transition-opacity group-hover:opacity-100">
              <Icon class="h-4 w-4 text-white" name="edit-entry" />
            </div>
          </label>
          <Show when={props.logo}>
            <Button
              variant="secondary"
              text="Remove"
              onClick={() => props.onRemoveLogo?.()}
            />
          </Show>
        </div>

        <p class="truncate font-semibold text-neutral-900 text-size-medium leading-snug">
          {props.name || "Untitled Space"}
        </p>
        <Show when={props.description}>
          <p class="mt-0.5 line-clamp-2 text-neutral-500 text-size-small leading-snug">
            {props.description}
          </p>
        </Show>
        <p class="mt-1 truncate font-mono text-neutral-400 text-size-extra-small">
          {props.slug || "space-slug"}
        </p>
      </div>
    </div>
  );
}
