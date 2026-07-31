import { createSignal, type JSX, Show } from "solid-js";
import { Icon } from "./Icon.tsx";

interface Props {
  accept?: string;
  /** Small text shown below the main call-to-action (e.g. accepted formats). */
  hint?: string;
  onSelect?: (file: File) => void;
  /** Replaces the default prompt. Receives the live drag state and the picker. */
  children?: (state: {
    isDragging: () => boolean;
    openPicker: () => void;
  }) => JSX.Element;
  class?: string;
  /**
   * Imperative handle, handed back through the `ref` prop.
   *
   * `isDragging` is a getter, not an accessor: a parent reads it as a value,
   * and it stays reactive because the getter reads the signal at the point of
   * use. `openPicker` is an action and stays a function.
   */
  ref?: (handle: { readonly isDragging: boolean; openPicker: () => void }) => void;
}

export function FileDrop(props: Props) {
  const [isDragging, setIsDragging] = createSignal(false);
  let dropZone: HTMLDivElement | undefined;

  function isAccepted(file: File): boolean {
    if (!props.accept) return true;
    return props.accept.split(",").some((type) => {
      const t = type.trim();
      if (t.startsWith(".")) return file.name.toLowerCase().endsWith(t.toLowerCase());
      if (t.endsWith("/*")) return file.type.startsWith(t.slice(0, -1));
      return file.type === t;
    });
  }

  function pick(file: File) {
    if (isAccepted(file)) props.onSelect?.(file);
  }

  function openPicker() {
    const input = document.createElement("input");
    input.type = "file";
    if (props.accept) input.accept = props.accept;
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (file) pick(file);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  }

  props.ref?.({
    get isDragging() {
      return isDragging();
    },
    openPicker,
  });

  return (
    /* biome-ignore lint/a11y/noStaticElementInteractions: the drop zone is the control. */
    /* biome-ignore lint/a11y/useKeyWithClickEvents: the inner button is the keyboard path. */
    <div
      ref={dropZone}
      class={`relative flex flex-col items-center justify-center gap-3xs rounded-xl border-2 border-dashed px-m py-l transition-colors hover:border-neutral-400 hover:bg-neutral-50 ${props.class ?? ""}`}
      classList={{
        "border-neutral-400 bg-neutral-50": isDragging(),
        "border-neutral-200 bg-transparent": !isDragging(),
      }}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        if (!dropZone?.contains(event.relatedTarget as Node)) setIsDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        const file = event.dataTransfer?.files?.[0];
        if (file) pick(file);
      }}
      onPaste={(event) => {
        const file = event.clipboardData?.files?.[0];
        if (file) pick(file);
      }}
      onClick={openPicker}
    >
      <Show
        when={props.children}
        fallback={
          <>
            <div
              class="flex h-14 w-14 items-center justify-center rounded-full transition-colors"
              classList={{
                "bg-neutral-200": isDragging(),
                "bg-neutral-100": !isDragging(),
              }}
            >
              <Icon name="upload" />
            </div>

            <p class="text-center text-neutral-700 text-size-normal">
              Drag &amp; drop here or{" "}
              <button
                type="button"
                class="cursor-pointer font-medium text-neutral-700 underline-offset-2 hover:text-neutral-900 hover:underline"
                onClick={(event) => {
                  event.stopPropagation();
                  openPicker();
                }}
              >
                choose file
              </button>
            </p>

            <Show when={props.hint}>
              <p class="-mt-1 text-center text-neutral-400 text-small">{props.hint}</p>
            </Show>
          </>
        }
      >
        {(render) => render()({ isDragging, openPicker })}
      </Show>
    </div>
  );
}
