import { createMemo, For, onCleanup, onMount, Show } from "solid-js";
import type { DocumentWithProperties } from "#api/client.ts";
import { api } from "#api/client.ts";
import { useDocumentDrag } from "#composeables/useDocumentDrag.ts";
import { usePinnedDocuments } from "#composeables/usePinnedDocuments.ts";
import { useRoute } from "#composeables/useRoute.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale, useTranslation } from "#composeables/useTranslation.ts";
import { documentTypeIcon } from "#documents/icons.ts";
import { documentTitle } from "#documents/title.ts";
import { spacePath } from "#utils/utils.ts";
import { Icon } from "./Icon.tsx";
import { MenuLink } from "./MenuLink.tsx";

/** Reserved `data-category-id` for the pinned-documents drop target — never a real category id. */
export const PINNED_CATEGORY_ID = "__pinned__";

/**
 * Pinned documents, listed above the categories as nav rows rather than tree
 * rows: they line up with Activity/Settings by construction and collapse to
 * icon-plus-tooltip with the rest of the nav. A dashed drop target appears
 * here while any document is being dragged.
 */
export function PinnedDocuments() {
  const t = useTranslation();
  const lang = useLocale();
  const { currentSpace } = useSpace();
  const { documentSlug: activeDocSlug } = useRoute();
  const { pinnedDocuments } = usePinnedDocuments();
  const { draggedDocument } = useDocumentDrag();

  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: "base" });

  const documents = createMemo(() =>
    [...pinnedDocuments()].sort((left, right) =>
      collator.compare(documentTitle(left, lang), documentTitle(right, lang)),
    ),
  );

  async function handleDocumentCategoryChange(event: Event) {
    const { documentId, newCategoryId } = (event as CustomEvent).detail;
    if (newCategoryId !== PINNED_CATEGORY_ID) return;

    const space = currentSpace();
    if (!space) return;

    await api.document.patch(space.id, documentId, {
      properties: { pinned: { value: true } },
    });
  }

  onMount(() => {
    window.addEventListener("document-category-change", handleDocumentCategoryChange);
    onCleanup(() =>
      window.removeEventListener(
        "document-category-change",
        handleDocumentCategoryChange,
      ),
    );
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a plain drop target, not a control.
    <category-target
      attr:data-category-id={PINNED_CATEGORY_ID}
      attr:data-space-id={currentSpace()?.id}
      class="flex flex-col gap-0.5 rounded-md [&[data-drag-over]]:bg-neutral-100"
    >
      <For each={documents()}>
        {(doc: DocumentWithProperties) => {
          const url = () => spacePath(currentSpace()?.slug, `/doc/${doc.slug}`);
          return (
            <page-target
              attr:data-document-id={doc.id}
              attr:data-document-type={doc.type ?? undefined}
              attr:data-space-id={currentSpace()?.id}
              attr:data-document-url={url()}
              class="block [&[data-dragging]]:opacity-50"
            >
              <MenuLink
                icon={documentTypeIcon(doc.type)}
                text={documentTitle(doc, lang)}
                href={url()}
                isActive={activeDocSlug() === doc.slug}
              />
            </page-target>
          );
        }}
      </For>

      {/* The slot is always in the layout, empty until a drag starts. Showing
          the box only while dragging would push every category down 32px the
          moment you pick a document up, moving the drop target out from under
          the cursor. */}
      <div class="min-h-[32px]">
        <Show when={!!draggedDocument()}>
          <div class="flex min-h-[32px] items-center gap-1.5 @max-xs:justify-start rounded-md border border-neutral-300 border-dashed px-3xs text-neutral-500 text-size-normal">
            <Icon class="h-3.5 w-3.5 flex-none" name="pin-to-home" />
            <span class="@max-xs:hidden">{t("Pin document")}</span>
          </div>
        </Show>
      </div>
    </category-target>
  );
}
