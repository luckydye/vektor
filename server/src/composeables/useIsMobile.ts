import { createSignal, onCleanup, onMount } from "solid-js";

/** Below Tailwind's `md` breakpoint, where the touch layout takes over. */
export const MOBILE_QUERY = "(max-width: 767px)";

/** False until mounted, so the first client render matches the server's. */
export function useIsMobile() {
  const [isMobile, setIsMobile] = createSignal(false);
  onMount(() => {
    const query = window.matchMedia(MOBILE_QUERY);
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener("change", update);
    onCleanup(() => query.removeEventListener("change", update));
  });
  return isMobile;
}
