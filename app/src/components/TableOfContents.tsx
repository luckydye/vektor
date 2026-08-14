import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

const HEADING_SELECTOR = "h1, h2, h3, h4, h5, h6";
const HEADER_OFFSET = 88;
const ACTIVE_LINE = HEADER_OFFSET + 24;
const REBUILD_DEBOUNCE_MS = 200;
const HOST_POLL_INTERVAL_MS = 150;
const HOST_POLL_TIMEOUT_MS = 15_000;

interface Heading {
  element: HTMLElement;
  level: number;
  text: string;
}

function liveDocumentRoot(): ShadowRoot | null {
  return document.querySelector("main document-view")?.shadowRoot ?? null;
}

function collectHeadings(root: ShadowRoot): Heading[] {
  const headings: Heading[] = [];

  for (const element of root.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
    const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;

    headings.push({
      element,
      level: Number(element.tagName.slice(1)),
      text,
    });
  }

  return headings;
}

function nearestScroller(element: HTMLElement): Element {
  let node: Node | null = element.parentNode;

  while (node) {
    if (node instanceof ShadowRoot) {
      node = node.host;
      continue;
    }
    if (!(node instanceof HTMLElement)) break;

    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === "auto" || overflowY === "scroll") &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
    node = node.parentNode;
  }

  return document.scrollingElement ?? document.documentElement;
}

function scrollToHeading(element: HTMLElement): void {
  const scroller = nearestScroller(element);
  const top = element.getBoundingClientRect().top;

  if (scroller === document.scrollingElement || scroller === document.documentElement) {
    window.scrollTo({
      top: window.scrollY + top - HEADER_OFFSET,
      behavior: "smooth",
    });
    return;
  }

  const delta = top - scroller.getBoundingClientRect().top - HEADER_OFFSET;
  scroller.scrollBy({ top: delta, behavior: "smooth" });
}

interface Props {
  onHide: () => void;
}

export function TableOfContents(props: Props) {
  const [headings, setHeadings] = createSignal<Heading[]>([]);
  const [activeIndex, setActiveIndex] = createSignal(-1);

  onMount(() => {
    let observer: MutationObserver | undefined;
    let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
    let hostTimer: ReturnType<typeof setInterval> | undefined;
    let activeFrame: number | undefined;
    let disposed = false;

    function updateActive() {
      activeFrame = undefined;
      const currentHeadings = headings();
      if (currentHeadings.length === 0) {
        setActiveIndex(-1);
        return;
      }

      let current = 0;
      for (let index = 0; index < currentHeadings.length; index++) {
        if (currentHeadings[index].element.getBoundingClientRect().top <= ACTIVE_LINE) {
          current = index;
        } else {
          break;
        }
      }
      setActiveIndex(current);
    }

    function scheduleActiveUpdate() {
      if (disposed || activeFrame !== undefined) return;
      activeFrame = requestAnimationFrame(updateActive);
    }

    function rebuild(root: ShadowRoot) {
      setHeadings(collectHeadings(root));
      scheduleActiveUpdate();
    }

    function observe(root: ShadowRoot) {
      rebuild(root);
      observer = new MutationObserver(() => {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => rebuild(root), REBUILD_DEBOUNCE_MS);
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    const root = liveDocumentRoot();
    if (root) {
      observe(root);
    } else {
      const startedAt = performance.now();
      hostTimer = setInterval(() => {
        const nextRoot = liveDocumentRoot();
        if (nextRoot) {
          observe(nextRoot);
          clearInterval(hostTimer);
          hostTimer = undefined;
        } else if (performance.now() - startedAt > HOST_POLL_TIMEOUT_MS) {
          clearInterval(hostTimer);
          hostTimer = undefined;
        }
      }, HOST_POLL_INTERVAL_MS);
    }

    document.addEventListener("scroll", scheduleActiveUpdate, {
      capture: true,
      passive: true,
    });
    window.addEventListener("resize", scheduleActiveUpdate, { passive: true });

    onCleanup(() => {
      disposed = true;
      document.removeEventListener("scroll", scheduleActiveUpdate, { capture: true });
      window.removeEventListener("resize", scheduleActiveUpdate);
      if (hostTimer !== undefined) clearInterval(hostTimer);
      if (activeFrame !== undefined) cancelAnimationFrame(activeFrame);
      clearTimeout(rebuildTimer);
      observer?.disconnect();
    });
  });

  const minimumLevel = () =>
    headings().reduce(
      (minimum, heading) => Math.min(minimum, Math.max(heading.level, 2)),
      Number.POSITIVE_INFINITY,
    );

  return (
    <nav
      aria-label="Table of contents"
      class="max-h-[calc(100vh-8rem)] overflow-y-auto font-sans"
    >
      <div class="mb-1.5 flex items-center justify-between gap-2 pl-3">
        <p class="m-0 font-semibold text-neutral-400 text-size-small uppercase tracking-[0.04em]">
          On this page
        </p>
        <button
          type="button"
          class="cursor-pointer rounded-md bg-neutral-50 px-2 py-1 font-medium text-neutral-700 text-size-small transition-colors hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-primary-500 focus-visible:outline-offset-2"
          onClick={props.onHide}
        >
          Hide
        </button>
      </div>

      <Show
        when={headings().length > 0}
        fallback={
          <p class="m-0 pl-3 text-neutral-400 text-size-normal">
            Headings appear here as you write them.
          </p>
        }
      >
        <ul class="m-0 list-none border-neutral-100 border-l p-0">
          <For each={headings()}>
            {(heading, index) => (
              <li>
                <button
                  type="button"
                  aria-current={activeIndex() === index() ? "location" : undefined}
                  class={`-ml-px block w-full cursor-pointer truncate border-l py-1 pr-2 text-left text-size-medium leading-[1.35] hover:border-neutral-300 hover:text-neutral-800 ${
                    activeIndex() === index()
                      ? "border-primary-600 font-medium text-primary-600"
                      : "border-transparent text-neutral-500"
                  }`}
                  style={{
                    "padding-left": `${
                      10 +
                      Math.min(Math.max(heading.level, 2) - minimumLevel(), 3) * 12
                    }px`,
                  }}
                  title={heading.text}
                  onClick={() => {
                    scrollToHeading(heading.element);
                    setActiveIndex(index());
                  }}
                >
                  {heading.text}
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </nav>
  );
}
