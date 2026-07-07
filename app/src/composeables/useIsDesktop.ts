import { onScopeDispose, ref } from "vue";

// Matches the Tailwind `md` breakpoint used across the layout (sidebar, docked
// panels). Reactive to viewport changes; defaults to desktop on the server and
// before mount so SSR markup is desktop-first.
const DESKTOP_QUERY = "(min-width: 768px)";

export function useIsDesktop() {
  const isDesktop = ref(true);

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const mq = window.matchMedia(DESKTOP_QUERY);
    isDesktop.value = mq.matches;
    const onChange = (e: MediaQueryListEvent) => {
      isDesktop.value = e.matches;
    };
    mq.addEventListener("change", onChange);
    onScopeDispose(() => mq.removeEventListener("change", onChange));
  }

  return isDesktop;
}
