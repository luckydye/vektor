import { children, createEffect, For, type JSX, Show } from "solid-js";
import { useSpace } from "#composeables/useSpace.ts";
import { spacePath } from "#utils/utils.ts";
import { CategoryBadge } from "./CategoryBadge.tsx";
import { TitleEditor } from "./TitleEditor.tsx";

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
  /** Replaces the category link, e.g. with an editable category chip. */
  categorySlot?: JSX.Element;
  parents?: BreadcrumbItem[];
  currentTitle: string;
  documentId?: string;
  spaceId?: string;
  canEdit?: boolean;
  class?: string;
}

export function Breadcrumbs(props: Props) {
  const { currentSpace } = useSpace();
  const parents = () => props.parents ?? [];
  // Resolved once: every read of a JSX prop would create the slot anew.
  const categorySlot = children(() => props.categorySlot);
  const showBreadcrumbs = () =>
    categorySlot() || props.category || parents().length > 0;

  let olRef: HTMLOListElement | undefined;

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
        class={`breadcrumbs flex min-w-0 items-center text-neutral-700 text-size-medium ${props.class ?? ""}`}
      >
        {/* Outside the scrolling list, which would clip the slot's popovers. */}
        <Show when={categorySlot()}>
          <div class="pointer-events-auto flex shrink-0 items-center gap-1">
            {categorySlot()}
            <span class="px-1 text-neutral-500" aria-hidden="true">
              &rsaquo;
            </span>
          </div>
        </Show>
        <ol
          ref={olRef}
          class="pointer-events-auto flex items-center gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <Show when={!categorySlot() && props.category}>
            {(category) => (
              <li class="flex shrink-0 items-center gap-1.5">
                {/* biome-ignore lint/a11y/useValidAnchor: href is computed. */}
                <a
                  href={spacePath(currentSpace()?.slug, `/?category=${category().slug}`)}
                  class="inline-flex items-center gap-1.5 transition-colors hover:text-neutral-900 hover:underline"
                >
                  <CategoryBadge category={category()} class="h-4 w-4" />
                  <span>{category().name}</span>
                </a>
                <span class="px-1 text-neutral-500" aria-hidden="true">
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
                <span class="px-1 text-neutral-500" aria-hidden="true">
                  &rsaquo;
                </span>
              </li>
            )}
          </For>

          <li class="shrink-0">
            <TitleEditor
              variant="breadcrumb"
              title={props.currentTitle}
              documentId={props.documentId}
              spaceId={props.spaceId}
              canEdit={props.canEdit}
            />
          </li>
        </ol>
      </nav>
    </Show>
  );
}
