import { onCleanup } from "solid-js";
import type { StorageArea } from "#utils/clientStorage.ts";
import { usePersistedState } from "./usePersistedState.ts";

const MIN_COL_WIDTH = 80;

/** Drag-resizable table column widths, remembered per key. */
export function useColumnWidths(options: {
  key: () => string | null;
  defaultWidth: (col: string) => number;
  area?: StorageArea;
}) {
  const {
    value: widths,
    commit,
    set,
  } = usePersistedState<Record<string, number>>({
    key: options.key,
    fallback: {},
    area: options.area,
  });

  function width(col: string): number {
    return widths()[col] ?? options.defaultWidth(col);
  }

  let stopResize: (() => void) | undefined;

  function startResize(col: string, event: PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = width(col);

    const onMove = (e: PointerEvent) => {
      set({
        ...widths(),
        [col]: Math.max(MIN_COL_WIDTH, startWidth + e.clientX - startX),
      });
    };
    const onUp = () => {
      stopResize?.();
      commit(widths());
    };
    stopResize = () => {
      stopResize = undefined;
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
  }

  onCleanup(() => stopResize?.());

  return { width, startResize };
}
