import { createSignal, type JSX, mergeProps, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { Icon } from "./Icon.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";

interface Props {
  disabled?: boolean;
  class?: string;
  children?: JSX.Element;
  onSelect?: (file: File) => void;
}

export function FileDropOverlay(props: Props) {
  const t = useTranslation();

  const merged = mergeProps({ disabled: false }, props);
  const [isDraggingFile, setIsDraggingFile] = createSignal(false);
  const [hasMounted, setHasMounted] = createSignal(false);
  onMount(() => setHasMounted(true));

  function containsFiles(event: DragEvent): boolean {
    return Array.from(event.dataTransfer?.types ?? []).includes("Files");
  }

  function handleDragEnter(event: DragEvent) {
    if (merged.disabled || !containsFiles(event)) return;
    event.preventDefault();
    setIsDraggingFile(true);
  }

  function handleDragOver(event: DragEvent) {
    if (merged.disabled || !containsFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    setIsDraggingFile(true);
  }

  function handleDragLeave(event: DragEvent) {
    const dropTarget = event.currentTarget as HTMLElement | null;
    const nextTarget = event.relatedTarget as Node | null;
    if (!dropTarget || !nextTarget || !dropTarget.contains(nextTarget)) {
      setIsDraggingFile(false);
    }
  }

  function handleDrop(event: DragEvent) {
    if (merged.disabled || !containsFiles(event)) return;
    event.preventDefault();
    setIsDraggingFile(false);

    const file = event.dataTransfer?.files?.[0];
    if (file) merged.onSelect?.(file);
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the handler forwards pointer events within this component; the element is not a standalone control.
    <div
      class={merged.class}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {merged.children}

      <Show when={hasMounted()}>
        <Portal>
          <inset-view
            hidden={!isDraggingFile()}
            class="overlay-fade pointer-events-none fixed inset-xs z-40 flex items-center justify-center rounded-2xl border-2 border-primary-300 border-dashed bg-background/95 shadow-large backdrop-blur-sm md:right-[calc(var(--inset-right,0px)+var(--spacing-xs))] md:left-[calc(var(--inset-left,0px)+var(--spacing-xs))]"
          >
            <div class="flex flex-col items-center gap-xs text-center text-primary-700">
              <Icon
                class="h-12 w-12 rounded-full bg-primary-50 p-3xs"
                name="upload-file"
              />
              <p class="font-semibold text-size-large">{t("Drop file to upload")}</p>
            </div>
          </inset-view>
        </Portal>
      </Show>
    </div>
  );
}
