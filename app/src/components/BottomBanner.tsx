import { createSignal, type JSX, onCleanup, onMount } from "solid-js";

interface Props {
  children: JSX.Element;
  /** Extra classes for the floating container (e.g. visibility rules). */
  class?: string;
}

/**
 * Floats a notice above the bottom of the viewport, aligned with the column it
 * is rendered in. A zero-height anchor stays in the normal flow so the fixed
 * element can track that column's left edge and width as the layout changes;
 * `inset-x-0` keeps it usable before the first measurement (SSR, pre-hydration).
 */
export function BottomBanner(props: Props) {
  const [style, setStyle] = createSignal<{ left: string; width: string }>();
  let anchorEl: HTMLDivElement | undefined;

  function updatePosition() {
    const bounds = anchorEl?.getBoundingClientRect();
    if (!bounds) return;
    setStyle({ left: `${bounds.left}px`, width: `${bounds.width}px` });
  }

  onMount(() => {
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    if (anchorEl) observer.observe(anchorEl);
    window.addEventListener("resize", updatePosition);

    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
    });
  });

  return (
    <>
      <div ref={anchorEl} class="h-0" />
      <div
        class={`pointer-events-none fixed inset-x-0 bottom-4 z-60 flex justify-center px-4 ${props.class ?? ""}`}
        style={style()}
      >
        {props.children}
      </div>
    </>
  );
}
