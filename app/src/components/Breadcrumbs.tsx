import { createEffect, For, Show } from "solid-js";
import { useSpace } from "#composeables/useSpace.solid.ts";
import { spacePath } from "#utils/utils.ts";

interface BreadcrumbItem {
  id: string;
  slug: string;
  title: string;
}

interface Category {
  id: string;
  name: string;
  slug: string;
  color?: string;
  icon?: string;
}

interface Props {
  category?: Category | null;
  parents?: BreadcrumbItem[];
  currentTitle: string;
}

export function Breadcrumbs(props: Props) {
  const { currentSpace } = useSpace();
  const parents = () => props.parents ?? [];
  const showBreadcrumbs = () => props.category || parents().length > 0;

  let olRef: HTMLOListElement | undefined;

  // Keep the deepest crumb visible when the trail overflows. Reading all three
  // inputs is what re-runs this; the DOM is already updated by the time a Solid
  // effect runs, so the old `nextTick` is unnecessary.
  createEffect(() => {
    void props.category;
    void parents();
    void props.currentTitle;
    if (olRef) olRef.scrollLeft = olRef.scrollWidth;
  });

  return (
    <Show when={showBreadcrumbs()}>
      <nav
        aria-label="Breadcrumb"
        class="breadcrumbs hidden min-w-0 text-neutral-600 text-size-medium md:flex"
      >
        <ol
          ref={olRef}
          class="pointer-events-auto flex items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <Show when={props.category}>
            {(category) => (
              <li class="flex shrink-0 items-center gap-1.5">
                {/* biome-ignore lint/a11y/useValidAnchor: href is computed. */}
                <a
                  href={spacePath(currentSpace()?.slug, `/?category=${category().slug}`)}
                  class="inline-flex items-center gap-1.5 transition-colors hover:text-neutral-900 hover:underline"
                >
                  <Show when={category().icon}>
                    <span class="text-base">{category().icon}</span>
                  </Show>
                  <span>{category().name}</span>
                </a>
                <span class="px-1 text-neutral-400" aria-hidden="true">
                  &rsaquo;
                </span>
              </li>
            )}
          </Show>

          <For each={parents()}>
            {(parent) => (
              <li class="flex shrink-0 items-center gap-1.5">
                {/* biome-ignore lint/a11y/useValidAnchor: href is computed. */}
                <a
                  href={spacePath(currentSpace()?.slug, `/doc/${parent.slug}`)}
                  class="max-w-[200px] truncate px-1 transition-colors hover:text-neutral-900 hover:underline"
                  title={parent.title}
                >
                  {parent.title}
                </a>
                <span class="px-1 text-neutral-400" aria-hidden="true">
                  &rsaquo;
                </span>
              </li>
            )}
          </For>

          <li class="shrink-0 px-1">
            <span
              class="block max-w-[200px] truncate font-medium text-neutral-900"
              title={props.currentTitle}
            >
              {props.currentTitle}
            </span>
          </li>
        </ol>
      </nav>
    </Show>
  );
}
