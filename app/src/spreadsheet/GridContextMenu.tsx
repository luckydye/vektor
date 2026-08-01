import { createEffect, For, onCleanup, Show } from "solid-js";
import { ContextMenuItem } from "#components/ContextMenuItem.tsx";

export interface GridMenuAction {
  label: string;
  run: () => void;
  /** Draw a divider above this entry. */
  separated?: boolean;
}

interface Props {
  /** Where the right-click landed, in client coordinates; null when closed. */
  at: { x: number; y: number } | null;
  actions: GridMenuAction[];
  onClose: () => void;
}

/**
 * The grid's right-click menu. `#components/ContextMenu.tsx` hangs off a trigger
 * button, so this positions its own panel at the pointer, but reuses the same
 * item so the two menus look and behave alike.
 */
export function GridContextMenu(props: Props) {
  let panel: HTMLDivElement | undefined;

  createEffect(() => {
    if (!props.at) return;
    const close = () => props.onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (panel && !panel.contains(event.target as Node)) close();
    };
    // Capture, so a click anywhere closes the menu before that click is acted on.
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("resize", close);
    onCleanup(() => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("resize", close);
    });
  });

  // Keep the panel on screen when the click lands near an edge.
  createEffect(() => {
    const at = props.at; // solid-reactivity-ok: read inside an effect, so it re-runs
    if (!at || !panel) return;
    const { width, height } = panel.getBoundingClientRect();
    panel.style.left = `${Math.min(at.x, window.innerWidth - width - 8)}px`;
    panel.style.top = `${Math.min(at.y, window.innerHeight - height - 8)}px`;
  });

  return (
    <Show when={props.at}>
      <div
        ref={panel}
        class="fixed z-50 min-w-[180px] rounded-lg border border-neutral-100 bg-background p-5xs text-interactive shadow-large"
      >
        <For each={props.actions}>
          {(action) => (
            <ContextMenuItem
              class={action.separated ? "mt-5xs border-neutral-100 border-t pt-5xs" : ""}
              onClick={() => {
                action.run();
                props.onClose();
              }}
            >
              <span class="text-size-normal">{action.label}</span>
            </ContextMenuItem>
          )}
        </For>
      </div>
    </Show>
  );
}
