import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import "@atrium-ui/elements/tabs";

interface Tab {
  id: string;
  label: string;
}

interface Props {
  tabs: readonly Tab[];
  initialTab?: string;
  /** Panel content by tab id — Vue's named slots. */
  panels: Record<string, () => JSX.Element>;
  onTabChange?: (id: string) => void;
}

type ATabsEl = HTMLElement & {
  selectTabByIndex: (index: number, focus?: boolean) => void;
};

export function SettingsLayout(props: Props) {
  let tabsEl: ATabsEl | undefined;
  const [ready, setReady] = createSignal(false);
  const [selectedIndex, setSelectedIndex] = createSignal(0);

  function animatePanel(index: number, direction: "next" | "previous") {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    requestAnimationFrame(() => {
      const panel = tabsEl?.querySelectorAll("a-tabs-panel").item(index);
      const content = panel?.firstElementChild as HTMLElement | null;
      if (!content) return;

      for (const animation of content.getAnimations()) animation.cancel();

      const easing = getComputedStyle(document.documentElement)
        .getPropertyValue("--emphasized-curve")
        .trim();
      content.animate(
        [
          { opacity: 0, transform: `translateX(${direction === "next" ? 8 : -8}px)` },
          { opacity: 1, transform: "translateX(0)" },
        ],
        { duration: 180, easing: easing || "ease-out" },
      );
    });
  }

  function onTabSelected(event: Event) {
    const { index } = (event as CustomEvent<{ index: number }>).detail;
    // a-tabs binds its own tab-selected listener in the constructor but drops it
    // on disconnect, so it stops switching panels once something moves it in the
    // DOM (a-popover portals its content out). Driving the selection here works
    // either way.
    tabsEl?.selectTabByIndex(index, false);
    if (index !== selectedIndex()) {
      const direction = index > selectedIndex() ? "next" : "previous";
      setSelectedIndex(index);
      animatePanel(index, direction);
    }
    const tab = props.tabs[index];
    if (tab) props.onTabChange?.(tab.id);
  }

  onMount(async () => {
    await customElements.whenDefined("a-tabs");
    setReady(true);
    // No `nextTick`: setting the signal renders synchronously in Solid, so the
    // element exists by the time this line runs.
    if (props.initialTab) {
      const index = props.tabs.findIndex((t) => t.id === props.initialTab);
      if (index > 0) tabsEl?.selectTabByIndex(index, false);
    }
  });

  return (
    <div class="flex h-full min-h-0 flex-col p-2">
      <Show
        when={ready()}
        fallback={
          <>
            <div class="flex h-[51px] items-start gap-[10px] py-4xs">
              <For each={props.tabs}>
                {(tab) => (
                  <div class="inline-flex h-[27px] items-center justify-center rounded-sm px-5xs">
                    <div
                      class="h-[26px] animate-pulse rounded-md bg-neutral-100/70 px-3xs py-5xs"
                      style={{ width: `${tab.label.length * 6 + 24}px` }}
                    />
                  </div>
                )}
              </For>
            </div>
            <div class="space-y-3 px-2 py-4">
              <div class="h-3 w-2/3 animate-pulse rounded bg-neutral-100" />
              <div class="h-3 w-1/2 animate-pulse rounded bg-neutral-100" />
              <div class="h-3 w-3/4 animate-pulse rounded bg-neutral-100" />
            </div>
          </>
        }
      >
        <a-tabs ref={tabsEl} on:tab-selected={onTabSelected}>
          <a-tabs-list class="block overflow-clip py-4xs">
            <For each={props.tabs}>
              {(tab) => (
                <a-tabs-tab class="inline-flex h-[27px] items-center justify-center rounded-sm px-5xs text-label opacity-60 [&[selected]:hover_span]:bg-gray-100 [&[selected]]:opacity-100 [&[selected]_span]:bg-gray-100 hover:[&_span]:bg-gray-200">
                  <span class="inline-flex items-center justify-center rounded-md px-3xs py-5xs transition-colors">
                    {tab.label}
                  </span>
                </a-tabs-tab>
              )}
            </For>
          </a-tabs-list>
          <For each={props.tabs}>
            {(tab) => (
              <a-tabs-panel class="block min-w-0">
                <div class="px-2 py-4">{props.panels[tab.id]?.()}</div>
              </a-tabs-panel>
            )}
          </For>
        </a-tabs>
      </Show>
    </div>
  );
}
