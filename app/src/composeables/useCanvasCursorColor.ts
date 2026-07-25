import { type Ref, readonly, ref } from "vue";
import { isHexColor } from "#utils/color.ts";

const STORAGE_KEY = "user-canvas-cursor-color";
const DEFAULT_CURSOR_COLOR = "#3b82f6";

function readOverride(): string | null {
  if (typeof localStorage === "undefined") return null;
  const storedColor = localStorage.getItem(STORAGE_KEY);
  return isHexColor(storedColor) ? storedColor : null;
}

/**
 * The stored cursor-color override, or `null` when the user hasn't picked one.
 * A `null` value means "use the automatic (avatar-derived) presence color".
 *
 * Module-level so every surface (the canvas, editor/canvas presence, the
 * preferences panel) reads the same reactive value: a change made in the panel
 * reaches the canvas without either side wiring up an event listener.
 */
const cursorColorOverride = ref<string | null>(readOverride());

// One listener for the whole app, installed on first use. The `storage` event
// only fires in *other* tabs, so cross-tab changes stay in sync too.
let listening = false;

function startListening(): void {
  if (listening || typeof window === "undefined") return;
  listening = true;
  window.addEventListener("storage", (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) cursorColorOverride.value = readOverride();
  });
}

export function useCanvasCursorColor(): {
  cursorColorOverride: Readonly<Ref<string | null>>;
  setCursorColor: (color: string) => void;
  clearCursorColor: () => void;
} {
  startListening();

  return {
    cursorColorOverride: readonly(cursorColorOverride),

    setCursorColor(color: string) {
      const nextColor = isHexColor(color) ? color : DEFAULT_CURSOR_COLOR;
      localStorage.setItem(STORAGE_KEY, nextColor);
      cursorColorOverride.value = nextColor;
    },

    /** Clears the override so presence falls back to the automatic avatar color. */
    clearCursorColor() {
      if (typeof localStorage === "undefined") return;
      localStorage.removeItem(STORAGE_KEY);
      cursorColorOverride.value = null;
    },
  };
}
