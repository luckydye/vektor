import "@atrium-ui/elements/popover";
import { createSignal, type JSX, Show } from "solid-js";
import { useTranslation } from "#composeables/useTranslation.ts";
import { imageFileAsDataUrl } from "#utils/image.ts";
import { ColorPickerPanel } from "./ColorPickerPanel.tsx";
import { Icon } from "./Icon.tsx";

interface Props {
  /** The badge as it will show, rendered at 44px. */
  preview: JSX.Element;
  /** An uploaded image as a data URL, or empty. */
  image: string;
  onUpdateImage?: (value: string) => void;
  /** Short text shown instead of an image, for badges that offer it. */
  text?: { value: string; placeholder: string; onUpdate: (value: string) => void };
  color: string;
  /** Offers a "No color" choice below the picker. */
  allowTransparent?: boolean;
  onUpdateColor?: (value: string) => void;
}

/**
 * A badge preview that opens one popover for everything the badge is made of:
 * its text or uploaded image, and its colour.
 */
export function BadgeEditor(props: Props) {
  const t = useTranslation();
  const [imageError, setImageError] = createSignal("");

  async function handleImageUpload(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      props.onUpdateImage?.(await imageFileAsDataUrl(file));
      setImageError("");
    } catch (error) {
      setImageError(
        error instanceof Error ? error.message : t("Failed to read image file"),
      );
    } finally {
      input.value = "";
    }
  }

  return (
    <a-popover-trigger showdelay="0" hidedelay="100" class="flex flex-none">
      <button
        slot="trigger"
        type="button"
        title={t("Change icon and color")}
        aria-label={t("Change icon and color")}
        class="group/badge relative h-11 w-11 cursor-pointer rounded-lg transition-transform active:scale-95"
      >
        {props.preview}
        <span class="absolute -right-1 -bottom-1 flex h-5 w-5 items-center justify-center rounded-full border border-(--control-border) bg-background text-neutral-600 shadow-sm transition-colors group-hover/badge:text-neutral-900">
          <Icon class="h-3 w-3" name="edit-entry" />
        </span>
      </button>

      <a-popover class="group" placements="bottom-start,top-start">
        <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
          <div class="flex origin-top-left scale-95 flex-col gap-3 rounded-lg border border-(--menu-surface-border) bg-background p-2 shadow-large transition-all duration-150 group-[&[enabled]]:scale-100">
            <div class="flex w-[220px] items-center gap-1.5">
              <Show when={props.text}>
                {(text) => (
                  <input
                    title={t("Icon (emoji or text)")}
                    aria-label={t("Icon")}
                    value={props.image ? "" : text().value}
                    onInput={(event) => {
                      setImageError("");
                      text().onUpdate(event.currentTarget.value);
                    }}
                    type="text"
                    maxlength="10"
                    placeholder={text().placeholder}
                    class="form-control h-7 w-12 flex-none px-0 py-0 text-center"
                  />
                )}
              </Show>
              <label class="button-neutral button-small flex-1 justify-center focus-within:ring-2 focus-within:ring-primary-500/40">
                <input
                  type="file"
                  accept="image/svg+xml,image/png,image/jpeg"
                  class="sr-only"
                  onChange={(event) => void handleImageUpload(event)}
                />
                {props.image ? t("Change image") : t("Upload image")}
              </label>
              <Show when={props.image}>
                <button
                  type="button"
                  title={t("Remove")}
                  aria-label={t("Remove")}
                  class="button-neutral button-small"
                  onClick={() => props.onUpdateImage?.("")}
                >
                  <Icon class="h-3.5 w-3.5" name="cancel" />
                </button>
              </Show>
            </div>
            <Show when={imageError()}>
              <p class="form-error w-[220px]">{imageError()}</p>
            </Show>

            <ColorPickerPanel
              value={props.color}
              allowTransparent={props.allowTransparent}
              onUpdateValue={(color) => props.onUpdateColor?.(color)}
            />
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>
  );
}
