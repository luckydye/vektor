import { type MaybeRefOrGetter, toValue, watchEffect } from "vue";
import { useSpace } from "#composeables/useSpace.ts";

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
export function usePageTitle(title: MaybeRefOrGetter<string | null | undefined>) {
  const { currentSpace } = useSpace();

  watchEffect(() => {
    if (typeof document === "undefined") return;
    const parts = [toValue(title), currentSpace.value?.name, "Vektor"].filter(Boolean);
    document.title = parts.join(" - ");
  });
}
