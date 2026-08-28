import { createEffect } from "solid-js";
import "@atrium-ui/elements/popover";
import { FileDrop } from "./FileDrop.tsx";
import { Icon } from "./Icon.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";

const HEADER_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";

interface Props {
  show?: boolean;
  onUpdateShow?: (value: boolean) => void;
  onSelect?: (file: File) => void;
}

export function HeaderImageDialog(props: Props) {
  const t = useTranslation();

  let triggerRef: HTMLButtonElement | undefined;
  let cancelRef: HTMLButtonElement | undefined;

  createEffect(() => {
    if (props.show) triggerRef?.click();
  });

  function close() {
    cancelRef?.dispatchEvent(new CustomEvent("exit", { bubbles: true }));
  }

  function onSelect(file: File) {
    props.onSelect?.(file);
    close();
  }

  return (
    <a-popover-trigger class="group absolute top-0 left-0 h-0 w-0 overflow-hidden">
      <button
        ref={triggerRef}
        slot="trigger"
        type="button"
        class="block h-0 w-0 overflow-hidden"
        tabindex="-1"
      />

      <a-popover
        class="group"
        placements="bottom-end"
        on:exit={() => props.onUpdateShow?.(false)}
      >
        <div class="w-max opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
          <div class="w-[400px] origin-top-right scale-95 rounded-2xl border border-neutral-100 bg-background p-m shadow-large transition-all duration-150 group-[&[enabled]]:scale-100">
            <div class="flex flex-col gap-s">
              <div class="flex flex-col items-center gap-5xs text-center">
                <h2 class="font-semibold text-neutral-900 text-size-large">
                  {t("Header image")}
                </h2>
                <p class="text-neutral-400 text-small">
                  {t("Upload an image for this document")}
                </p>
              </div>

              <FileDrop
                accept={HEADER_IMAGE_ACCEPT}
                hint="PNG · JPEG · GIF · WebP · SVG"
                onSelect={onSelect}
              >
                {({ isDragging, openPicker }) => (
                  <>
                    <div
                      class="flex h-14 w-14 items-center justify-center rounded-full transition-colors"
                      classList={{
                        "bg-neutral-200": isDragging(),
                        "bg-neutral-100": !isDragging(),
                      }}
                    >
                      <Icon name="upload-file" class="h-7 w-7 text-neutral-500" />
                    </div>

                    <p class="text-center text-neutral-700 text-size-normal">
                      {t("Drag & drop here or")}{" "}
                      <button
                        type="button"
                        class="cursor-pointer font-medium text-neutral-700 underline-offset-2 hover:text-neutral-900 hover:underline"
                        onClick={(event) => {
                          event.stopPropagation();
                          openPicker();
                        }}
                      >
                        {t("choose file")}
                      </button>
                    </p>

                    <p class="-mt-1 text-center text-neutral-400 text-small">
                      PNG · JPEG · GIF · WebP · SVG
                    </p>
                  </>
                )}
              </FileDrop>

              <button
                ref={cancelRef}
                type="button"
                class="text-center text-neutral-400 text-small transition-colors hover:text-neutral-600"
                onClick={close}
              >
                {t("Cancel")}
              </button>
            </div>
          </div>
        </div>
      </a-popover>
    </a-popover-trigger>
  );
}
