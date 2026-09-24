import { createSignal, onCleanup } from "solid-js";

// Matches the Tailwind `md` breakpoint used across the layout (sidebar, docked
// panels). Reactive to viewport changes; defaults to desktop on the server and
// before mount so SSR markup is desktop-first.
const DESKTOP_QUERY = "(min-width: 768px)";

export function useIsDesktop() {
  const [isDesktop, setIsDesktop] = createSignal(true);

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const mq = window.matchMedia(DESKTOP_QUERY);
    setIsDesktop(mq.matches);
    const onChange = (e: MediaQueryListEvent) => {
      setIsDesktop(e.matches);
    };
    mq.addEventListener("change", onChange);
    onCleanup(() => mq.removeEventListener("change", onChange));
  }

  return isDesktop;
}
