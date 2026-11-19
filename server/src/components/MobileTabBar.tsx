import { For } from "solid-js";
import { Icon, type IconName } from "./Icon.tsx";

export interface MobileTab {
  icon: IconName;
  label: string;
  href: string;
  isActive: boolean;
  onSelect: () => void;
}

interface Props {
  tabs: MobileTab[];
}

/** The touch layout's primary navigation, pinned to the bottom edge. */
export function MobileTabBar(props: Props) {
  return (
    <nav class="fixed inset-x-0 bottom-0 z-30 flex border-neutral-100 border-t bg-neutral-15 pb-[env(safe-area-inset-bottom)] md:hidden dark:border-neutral-200">
      <For each={props.tabs}>
        {(tab) => (
          <a
            href={tab.href}
            // Concatenated: twMerge would drop `text-size-*` next to a text colour.
            class={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-size-extra-small transition-colors active:bg-neutral-100 ${
              tab.isActive ? "text-primary-700" : "text-neutral-500"
            }`}
            aria-current={tab.isActive ? "page" : undefined}
            onClick={tab.onSelect}
          >
            <Icon class="h-6 w-6" name={tab.icon} />
            <span>{tab.label}</span>
          </a>
        )}
      </For>
    </nav>
  );
}
