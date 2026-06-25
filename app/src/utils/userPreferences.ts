export const CANVAS_CURSOR_COLOR_STORAGE_KEY = "user-canvas-cursor-color";
export const CANVAS_CURSOR_COLOR_CHANGE_EVENT = "user-canvas-cursor-color-change";
export const DEFAULT_CANVAS_CURSOR_COLOR = "#3b82f6";

export function isHexColor(value: string | null): value is string {
  return /^#[0-9a-f]{6}$/i.test(value ?? "");
}

export function readCanvasCursorColor(): string {
  if (typeof localStorage === "undefined") return DEFAULT_CANVAS_CURSOR_COLOR;
  const storedColor = localStorage.getItem(CANVAS_CURSOR_COLOR_STORAGE_KEY);
  return isHexColor(storedColor) ? storedColor : DEFAULT_CANVAS_CURSOR_COLOR;
}

export function saveCanvasCursorColor(color: string): string {
  const nextColor = isHexColor(color) ? color : DEFAULT_CANVAS_CURSOR_COLOR;
  localStorage.setItem(CANVAS_CURSOR_COLOR_STORAGE_KEY, nextColor);
  window.dispatchEvent(
    new CustomEvent(CANVAS_CURSOR_COLOR_CHANGE_EVENT, {
      detail: { color: nextColor },
    }),
  );
  return nextColor;
}
