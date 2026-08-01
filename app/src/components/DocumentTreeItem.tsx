import { createMemo, For, Show } from "solid-js";
import type { DocumentWithProperties } from "#api/ApiClient.ts";
import { useDocumentDrag } from "#composeables/useDocumentDrag.ts";
import { useSpace } from "#composeables/useSpace.ts";
import {
  propertyValueIncludes,
  propertyValueToScalar,
  propertyValueToText,
} from "#documents/properties.ts";
import { allowsChildDocumentType } from "#documents/types.ts";
import { t } from "#utils/lang.ts";
import { spacePath } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  doc: DocumentWithProperties;
  allDocs: DocumentWithProperties[];
  activeDocId?: string | null;
  expandedItems: Set<string>;
  onToggle?: (id: string) => void;
}

function docTitle(doc: DocumentWithProperties) {
  const title = doc.properties?.title;
  return title ? propertyValueToText(title) : t("Untitled");
}

export function DocumentTreeItem(props: Props) {
  const { currentSpace } = useSpace();
  const { draggedDocument } = useDocumentDrag();

  // Dim rows that cannot parent the document being dragged (e.g. a plain
  // document dropped on a database, which only accepts records). The dragged
  // row itself keeps its own `data-dragging` styling.
  const isInvalidDropTarget = createMemo(() => {
    const dragged = draggedDocument();
    if (!dragged || dragged.id === props.doc.id) return false;
    return !allowsChildDocumentType(props.doc.type, dragged.type);
  });

  const children = createMemo(() => {
    const docCategory = props.doc.properties.category || props.doc.properties.collection;
    const docCategorySlug = propertyValueToScalar(docCategory);

    return props.allDocs.filter((d) => {
      if (d.parentId !== props.doc.id) return false;

      const childCategory = d.properties.category || d.properties.collection;

      // Include child if it has no explicit category (inherits) or same category as parent
      return (
        !childCategory ||
        !docCategorySlug ||
        propertyValueIncludes(childCategory, docCategorySlug)
      );
    });
  });

  const hasChildren = createMemo(() => children().length > 0);
  const isExpanded = createMemo(() => props.expandedItems.has(props.doc.id));
  const isActive = createMemo(() => props.activeDocId === props.doc.slug);

  function getDocumentUrl(docSlug: string) {
    return spacePath(currentSpace()?.slug, `/doc/${docSlug}`);
  }

  return (
    <page-target
      attr:data-document-id={props.doc.id}
      attr:data-document-type={props.doc.type ?? undefined}
      attr:data-space-id={currentSpace()?.id}
      attr:data-document-url={getDocumentUrl(props.doc.slug)}
      class="block pl-[0.535rem] [&[data-drag-over]]:bg-neutral-100 [&[data-dragging]]:opacity-50"
    >
      {/* Only the row dims: descendants may still be valid drop targets. */}
      <div
        class="flex items-center gap-1 transition-opacity"
        classList={{ "opacity-40": isInvalidDropTarget() }}
      >
        <Show when={hasChildren()} fallback={<div class="w-4 flex-none" />}>
          <button
            type="button"
            onClick={() => props.onToggle?.(props.doc.id)}
            class="rounded-sm p-0.5 hover:bg-neutral-300 active:bg-neutral-200"
            aria-label={isExpanded() ? t("Collapse") : t("Expand")}
          >
            <Icon
              class="h-3 w-3 text-neutral transition-transform"
              classList={{ "rotate-90": isExpanded() }}
              name="chevron-right-thin"
            />
          </button>
        </Show>

        <a
          href={getDocumentUrl(props.doc.slug)}
          class={`flex flex-1 items-center justify-between text-ellipsis whitespace-nowrap rounded-sm px-1.5 py-1 text-size-normal ${
            isActive()
              ? "bg-primary-200 text-neutral-700"
              : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 active:bg-neutral-200"
          }`}
        >
          <span>{docTitle(props.doc)}</span>
          <Show when={props.doc.mentionCount && props.doc.mentionCount > 0}>
            <span class="ml-2 min-w-[1.25rem] rounded-full bg-primary-600 px-1.5 text-center font-medium text-size-extra-small text-white leading-[1.25rem]">
              {props.doc.mentionCount}
            </span>
          </Show>
        </a>
      </div>

      <Show when={isExpanded() && hasChildren()}>
        <div class="mt-1 ml-2 space-y-1">
          <For each={children()}>
            {(child, index) => (
              <div class="relative">
                <Show
                  when={index() < children().length - 1}
                  fallback={
                    // L-shaped connector for the last item
                    <div class="absolute top-0 left-0 h-[0.975rem] w-[0.52rem] border-neutral-400 border-b border-l" />
                  }
                >
                  {/* continuous vertical rail for non-last items; extends through the space-y-1 gap */}
                  <div class="absolute top-0 bottom-[-0.25rem] left-0 w-0 border-neutral-400 border-l" />
                </Show>
                <DocumentTreeItem
                  doc={child}
                  allDocs={props.allDocs}
                  activeDocId={props.activeDocId}
                  expandedItems={props.expandedItems}
                  onToggle={props.onToggle}
                />
              </div>
            )}
          </For>
        </div>
      </Show>
    </page-target>
  );
}
