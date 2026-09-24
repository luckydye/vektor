import { type Accessor, createSignal } from "solid-js";
import {
  readStored,
  removeStored,
  subscribeStored,
  writeStored,
} from "#utils/clientStorage.ts";
import { isHexColor } from "#utils/color.ts";

const STORAGE_KEY = "user-canvas-cursor-color";
const DEFAULT_CURSOR_COLOR = "#3b82f6";

/**
 * Plain text rather than JSON: these entries predate this helper and are read raw
 * elsewhere, so quoting them now would invalidate every stored colour.
 */
const CURSOR_COLOR_CODEC = {
  parse: (raw: string) => (isHexColor(raw) ? raw : null),
  serialize: (color: string) => color,
};

function readOverride(): string | null {
  return readStored(STORAGE_KEY, CURSOR_COLOR_CODEC);
}

/**
 * The stored cursor-color override, or `null` when the user hasn't picked one.
 * A `null` value means "use the automatic (avatar-derived) presence color".
 *
 * Module-level so every surface (the canvas, editor/canvas presence, the
 * preferences panel) reads the same reactive value: a change made in the panel
 * reaches the canvas without either side wiring up an event listener.
 */
const [cursorColorOverride, setCursorColorOverride] = createSignal<string | null>(
  readOverride(),
);

// One listener for the whole app: a cursor colour is the same person in every tab,
// and the signal above is module-level.
subscribeStored(STORAGE_KEY, () => setCursorColorOverride(readOverride()));

export function useCanvasCursorColor(): {
  cursorColorOverride: Accessor<string | null>;
  setCursorColor: (color: string) => void;
  clearCursorColor: () => void;
} {
  return {
    cursorColorOverride: cursorColorOverride,

    setCursorColor(color: string) {
      const nextColor = isHexColor(color) ? color : DEFAULT_CURSOR_COLOR;
      writeStored(STORAGE_KEY, nextColor, CURSOR_COLOR_CODEC);
      setCursorColorOverride(nextColor);
    },

    /** Clears the override so presence falls back to the automatic avatar color. */
    clearCursorColor() {
      removeStored(STORAGE_KEY);
      setCursorColorOverride(null);
    },
  };
}
