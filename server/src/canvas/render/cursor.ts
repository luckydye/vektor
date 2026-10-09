const CURSOR_PATH =
  "M5.1 4.8a1.2 1.2 0 0 1 1.53-1.54l20.4 8.28a1.2 1.2 0 0 1-.14 2.26l-7.81 2.01a2.4 2.4 0 0 0-1.72 1.72l-2.01 7.81a1.2 1.2 0 0 1-2.26.14z";

const cache = new Map<string, string>();

/**
 * A `cursor` value drawing the collaborator pointer in a given colour, as an SVG
 * data URL because CSS cannot tint a cursor image. Cached by colour, since this
 * runs on every pointer colour change.
 */
export function makeCanvasCursor(color: string): string {
  const cached = cache.get(color);
  if (cached) return cached;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 32 32"><defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1.8" stdDeviation="1.8" flood-color="rgb(15,23,42)" flood-opacity="0.25"/></filter></defs><path d="${CURSOR_PATH}" fill="${color}" stroke="white" stroke-width="1.8" stroke-linejoin="round" filter="url(#s)"/></svg>`;
  const result = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 3 3, default`;
  cache.set(color, result);
  return result;
}
