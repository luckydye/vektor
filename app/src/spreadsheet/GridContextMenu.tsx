import { createEffect, For, Show } from "solid-js";
import { dismissOnOutsidePress } from "#spreadsheet/Popover.tsx";

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
 * The grid's right-click menu, positioned at the pointer.
 *
 * `#components/ContextMenu.tsx` hangs off a trigger button and is styled with
 * Tailwind, neither of which works here: this opens at a point, and it lives in
 * the spreadsheet's shadow root where the app's utility classes do not reach.
 * Its look is reproduced in `spreadsheet.css` instead.
 */
export function GridContextMenu(props: Props) {
  let panel: HTMLDivElement | undefined;

  dismissOnOutsidePress(
    () => props.at !== null,
    () => panel,
    () => props.onClose(),
  );

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
      <div class="ic-menu" ref={panel}>
        <ul>
          <For each={props.actions}>
            {(action) => (
              <li classList={{ "ic-menu-separated": action.separated }}>
                <button
                  type="button"
                  onClick={() => {
                    action.run();
                    props.onClose();
                  }}
                >
                  {action.label}
                </button>
              </li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
