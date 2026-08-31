import type { JSX } from "solid-js";
import { Show } from "solid-js";
import { Icon, type IconName } from "./Icon.tsx";
import "@atrium-ui/elements/tabs";

/**
 * The app's tab bar.
 *
 * A component rather than a set of classes to copy: the settings, workflow,
 * database and repository bars had each pasted the same markup and drifted into
 * three different heights and paddings. The styling lives here now, so there is
 * nothing to keep in sync.
 *
 * Two flavours, because the app drives tabs two ways and both are legitimate:
 * {@link Tab} inside {@link Tabs} uses the `a-tabs` custom element, which owns
 * selection and keyboard handling; {@link TabButton} is a plain button for bars
 * that manage their own state and need other controls beside each tab.
 */

/** What the element hands back when a tab is chosen. */
interface TabsElement extends HTMLElement {
  selectTabByIndex(index: number, focus?: boolean): void;
}

interface TabsProps {
  /** Index of the tab chosen, in the order they are declared. */
  onSelect: (index: number) => void;
  class?: string;
  children: JSX.Element;
}

/**
 * The list a tab bar lives in.
 *
 * Exported separately because the bars that also have `a-tabs-panel` children —
 * settings, workflow — own their `a-tabs` element for panel animation, and
 * should not have to give that up to share the tabs themselves.
 */
export function TabsList(props: { class?: string; children: JSX.Element }) {
  return (
    <a-tabs-list class={`block overflow-clip py-4xs ${props.class ?? ""}`}>
      {props.children}
    </a-tabs-list>
  );
}

/** A tab bar with no panels of its own. */
export function Tabs(props: TabsProps) {
  let element: TabsElement | undefined;

  // The element announces the intent and waits to be told: without this call
  // back into it, a click reports the choice but no tab becomes selected.
  function onTabSelected(event: Event) {
    const { index } = (event as CustomEvent<{ index: number }>).detail;
    element?.selectTabByIndex(index, false);
    props.onSelect(index);
  }

  return (
    <a-tabs ref={element as never} on:tab-selected={onTabSelected}>
      <TabsList class={props.class}>{props.children}</TabsList>
    </a-tabs>
  );
}

/**
 * The pill: icon and label, and the only thing that takes a background.
 *
 * Hover and selection share a tone. They are told apart by the text, which
 * goes from dimmed to full — a darker hover than the selected state reads as
 * heavier than the thing it is previewing.
 *
 * The parent's `selected` attribute rather than a descendant selector — an icon
 * is a span too, and `[&_span]` paints a box behind it.
 *
 * The hover group is named. A bare `group-hover` compiles to
 * `:where(.group):hover *`, which matches on the nearest `.group` ancestor —
 * and any wrapper that happens to carry one lights up every tab at once.
 */
function TabPill(props: { icon?: IconName; children: JSX.Element }) {
  return (
    <span class="inline-flex h-8 items-center justify-center gap-2 rounded-md px-3 transition-colors group-hover/tab:bg-gray-100 [[aria-selected=true]:hover>&]:bg-gray-100 [[aria-selected=true]>&]:bg-gray-100 [[selected]:hover>&]:bg-gray-100 [[selected]>&]:bg-gray-100">
      <Show when={props.icon}>{(icon) => <Icon class="h-4 w-4" name={icon()} />}</Show>
      {props.children}
    </span>
  );
}

const TAB_CLASS =
  "group/tab inline-flex h-9 items-center justify-center rounded-sm text-label opacity-60 transition-opacity [&[aria-selected=true]]:opacity-100 [&[selected]]:opacity-100";

interface TabProps {
  /** Only the initially selected tab needs this; the element takes over after. */
  selected?: boolean;
  icon?: IconName;
  /** Extra classes for the tab itself, e.g. hiding it at a breakpoint. */
  class?: string;
  children: JSX.Element;
}

/** A tab inside {@link Tabs}. */
export function Tab(props: TabProps) {
  return (
    <a-tabs-tab
      attr:selected={props.selected ? "" : undefined}
      class={`${TAB_CLASS} ${props.class ?? ""}`}
    >
      <TabPill icon={props.icon}>{props.children}</TabPill>
    </a-tabs-tab>
  );
}

interface TabButtonProps {
  selected: boolean;
  icon?: IconName;
  onClick: () => void;
  children: JSX.Element;
}

/** A tab for a bar that keeps its own state, styled as {@link Tab}. */
export function TabButton(props: TabButtonProps) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.selected}
      tabIndex={props.selected ? 0 : -1}
      class={TAB_CLASS}
      onClick={() => props.onClick()}
    >
      <TabPill icon={props.icon}>{props.children}</TabPill>
    </button>
  );
}
