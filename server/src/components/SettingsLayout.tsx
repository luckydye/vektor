import { createSignal, For, type JSX, onMount, Show } from "solid-js";
import { animateTabPanel } from "#utils/animate.ts";
import "@atrium-ui/elements/tabs";
import { Tab as TabItem, TabsList } from "./Tabs.tsx";

interface Tab {
  id: string;
  label: string;
}

interface Props {
  tabs: readonly Tab[];
  initialTab?: string;
  panels: Record<string, () => JSX.Element>;
  class?: string;
  onTabChange?: (id: string) => void;
}

type ATabsEl = HTMLElement & {
  selectTabByIndex: (index: number, focus?: boolean) => void;
};

export function SettingsLayout(props: Props) {
  let tabsEl: ATabsEl | undefined;
  let stickyEl: HTMLDivElement | undefined;
  const initialIndex = Math.max(
    props.tabs.findIndex((tab) => tab.id === props.initialTab),
    0,
  );
  const [ready, setReady] = createSignal(false);
  const [selectedIndex, setSelectedIndex] = createSignal(initialIndex);

  function animatePanel(index: number, direction: "next" | "previous") {
    requestAnimationFrame(() => {
      const panel = tabsEl?.querySelectorAll("a-tabs-panel").item(index);
      const content = panel?.firstElementChild as HTMLElement | null;
      if (content) animateTabPanel(content, direction);
    });
  }

  // Once the bar is stuck, the old panel's scroll offset would carry over to the new one.
  function scrollToPanelStart() {
    if (!tabsEl || !stickyEl) throw new Error("Tab selected before the tab bar mounted");
    const stuck =
      stickyEl.getBoundingClientRect().top > tabsEl.getBoundingClientRect().top;
    // The stuck bar reports its pinned position, so scroll its non-sticky parent instead.
    if (stuck) tabsEl.scrollIntoView({ block: "start" });
  }

  function onTabSelected(event: Event) {
    const { index } = (event as CustomEvent<{ index: number }>).detail;
    tabsEl?.selectTabByIndex(index, false);
    if (index !== selectedIndex()) {
      const direction = index > selectedIndex() ? "next" : "previous";
      scrollToPanelStart();
      setSelectedIndex(index);
      animatePanel(index, direction);
    }
    const tab = props.tabs[index];
    if (tab) props.onTabChange?.(tab.id);
  }

  onMount(async () => {
    await customElements.whenDefined("a-tabs");
    setReady(true);
  });

  return (
    <div class={`flex h-full min-h-0 flex-col px-2 pb-2 ${props.class ?? ""}`}>
      <Show
        when={ready()}
        fallback={
          <>
            <div class="pt-3">
              <div class="flex h-9 w-full items-center gap-1 overflow-hidden rounded-lg border border-neutral-100 px-1">
                <For each={props.tabs}>
                  {(tab) => (
                    <div class="inline-flex h-7 items-center px-4">
                      <div
                        class="h-3 animate-pulse rounded bg-skeleton"
                        style={{ width: `${tab.label.length * 7}px` }}
                      />
                    </div>
                  )}
                </For>
              </div>
            </div>
            <div class="space-y-3 px-2 pt-6 pb-4">
              <div class="h-3 w-2/3 animate-pulse rounded bg-skeleton" />
              <div class="h-3 w-1/2 animate-pulse rounded bg-skeleton" />
              <div class="h-3 w-3/4 animate-pulse rounded bg-skeleton" />
            </div>
          </>
        }
      >
        {/* Scroll anchoring would follow the old panel's content and undo scrollToPanelStart. */}
        <a-tabs ref={tabsEl} class="[overflow-anchor:none]" on:tab-selected={onTabSelected}>
          <div ref={stickyEl} class="sticky top-0 z-10 bg-neutral-10 pt-3">
            <TabsList class="w-full">
              <For each={props.tabs}>
                {(tab, index) => (
                  <TabItem selected={index() === initialIndex}>{tab.label}</TabItem>
                )}
              </For>
            </TabsList>
          </div>
          <For each={props.tabs}>
            {(tab) => (
              <a-tabs-panel class="block min-w-0">
                <div class="px-2 pt-6 pb-4">{props.panels[tab.id]?.()}</div>
              </a-tabs-panel>
            )}
          </For>
        </a-tabs>
      </Show>
    </div>
  );
}
