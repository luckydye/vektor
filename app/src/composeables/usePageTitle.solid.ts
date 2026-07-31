import { createEffect } from "solid-js";
import { type MaybeAccessor, useSpace } from "./useSpace.solid.ts";

/**
 * Keeps the browser tab title in sync with the current view.
 *
 * Every routed view must call this so SPA navigation never leaves a stale
 * `document.title` behind — the newly-mounted view always overwrites it. The
 * title also tracks its source reactively (e.g. a document being renamed).
 *
 * Pass the page-specific segment (e.g. a document name). Falsy values collapse
 * to just "{Space} - Vektor" (used by the space landing page).
 */
export function usePageTitle(title: MaybeAccessor<string | null | undefined>): void {
  const { currentSpace } = useSpace();

  createEffect(() => {
    if (typeof document === "undefined") return;
    const resolved = typeof title === "function" ? title() : title;
    const parts = [resolved, currentSpace()?.name, "Vektor"].filter(Boolean);
    document.title = parts.join(" - ");
  });
}
