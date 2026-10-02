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
      stickyEl.getBoundingClientRect().top > tabsEl.getBoundingClientRect().top - 16;
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
    <div class={`flex h-full min-h-0 flex-col p-2 ${props.class ?? ""}`}>
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
        {/* Scroll anchoring would follow the old panel's content and undo scrollToPanelStart. */}
        <a-tabs ref={tabsEl} class="[overflow-anchor:none]" on:tab-selected={onTabSelected}>
          <div ref={stickyEl} class="sticky top-0 z-10 -mt-4 bg-background pt-4">
            <TabsList>
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
