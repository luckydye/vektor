import "@atrium-ui/elements/color-picker";
import "@atrium-ui/elements/popover";
import { createSignal, For, Show } from "solid-js";
import { imageFileAsDataUrl } from "#utils/image.ts";
import { t } from "#utils/lang.ts";
import { CategoryBadge } from "./CategoryBadge.tsx";

/** Chip colours that stay readable behind an emoji at 24px, in either theme. */
const PRESET_COLORS = [
  "#4ECDC4",
  "#5B8DEF",
  "#9B7EDE",
  "#E8746C",
  "#E8A34C",
  "#6BBF59",
  "#E87BA8",
  "#7A8899",
];

interface Props {
  name: string;
  color: string;
  icon: string;
  onUpdateColor?: (value: string) => void;
  onUpdateIcon?: (value: string) => void;
}

/**
 * The category's colour and icon, shown as the sidebar row they produce. The
 * icon controls accept short text or the same image files as a space logo.
 */
export function CategoryAppearance(props: Props) {
  const [iconError, setIconError] = createSignal("");
  const isImageIcon = () => props.icon.startsWith("data:image/");

  async function handleIconUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      props.onUpdateIcon?.(await imageFileAsDataUrl(file));
      setIconError("");
    } catch (error) {
      setIconError(
        error instanceof Error ? error.message : t("Failed to read image file"),
      );
    } finally {
      input.value = "";
    }
  }

  return (
    <div class="space-y-2">
      <div class="rounded-lg border border-neutral-100 bg-neutral-50 px-2 py-2">
        <div class="flex items-center gap-2 text-neutral-900 text-size-normal">
          <CategoryBadge
            category={{ name: props.name || "?", color: props.color, icon: props.icon }}
            class="h-6 w-6"
          />
          <span class="truncate font-medium">{props.name || t("Untitled category")}</span>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label class="flex items-center gap-1.5 text-neutral-500 text-size-small">
          {t("Icon")}
          <input
            title={t("Icon (emoji or text)")}
            value={isImageIcon() ? "" : props.icon}
            onInput={(event) => {
              setIconError("");
              props.onUpdateIcon?.(event.currentTarget.value);
            }}
            type="text"
            maxlength="10"
            placeholder={(props.name || "?")[0].toUpperCase()}
            class="focus-ring h-7 w-10 flex-none rounded-md border border-neutral-100 text-center text-size-medium"
          />
        </label>

        <label class="focus-ring cursor-pointer rounded-md border border-neutral-100 px-2 py-1 text-neutral-700 text-size-small hover:bg-neutral-50">
          <input
            type="file"
            accept="image/svg+xml,image/png,image/jpeg"
            class="sr-only"
            onChange={(event) => void handleIconUpload(event)}
          />
          {isImageIcon() ? t("Change image") : t("Upload image")}
        </label>

        <Show when={isImageIcon()}>
          <button
            type="button"
            class="text-neutral-500 text-size-small hover:text-neutral-900"
            onClick={() => props.onUpdateIcon?.("")}
          >
            {t("Remove")}
          </button>
        </Show>

        <div class="flex flex-wrap items-center gap-1">
          <span class="mr-0.5 text-neutral-500 text-size-small">{t("Color")}</span>
          <For each={PRESET_COLORS}>
            {(color) => (
              <button
                type="button"
                title={color}
                aria-label={color}
                aria-pressed={props.color.toLowerCase() === color.toLowerCase()}
                onClick={() => props.onUpdateColor?.(color)}
                class="h-5 w-5 rounded-full outline-offset-2 hover:scale-110 hover:shadow-sm active:scale-95 aria-pressed:outline-2 aria-pressed:outline-neutral-900"
                style={{ "background-color": color }}
              />
            )}
          </For>

          <a-popover-trigger showdelay="0" hidedelay="100" class="flex">
            <button
              slot="trigger"
              type="button"
              title={t("Change color")}
              class="h-5 w-5 rounded-full border border-neutral-200 hover:scale-110 hover:shadow-sm active:scale-95"
              style={{
                background:
                  "conic-gradient(#e8746c, #e8a34c, #6bbf59, #4ecdc4, #5b8def, #9b7ede, #e87ba8, #e8746c)",
              }}
            />
            <a-popover class="group" placements="bottom-end">
              <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                <div class="origin-top-right scale-95 rounded-lg border border-neutral-100 bg-background p-2 shadow-large transition-all duration-150 group-[&[enabled]]:scale-100">
                  <a-color-picker
                    class="w-[220px]"
                    attr:value={props.color}
                    on:change={(event: Event) =>
                      props.onUpdateColor?.(
                        (event.target as HTMLElement & { value: string }).value,
                      )
                    }
                  />
                </div>
              </div>
            </a-popover>
          </a-popover-trigger>
        </div>
      </div>

      <Show when={iconError()}>
        <p class="text-red-600 text-size-small">{iconError()}</p>
      </Show>
    </div>
  );
}
