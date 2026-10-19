import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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

type Placement = "before" | "after";

function pinnedOrder(doc: DocumentWithProperties): number {
  const raw = doc.properties?.pinnedOrder;
  const order = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
}

/**
 * Pinned documents, listed above the categories as nav rows rather than tree
 * rows: they line up with Activity/Settings by construction and collapse to
 * icon-plus-tooltip with the rest of the nav. Dragging a document onto the
 * list pins it; the list outlines itself while a drag is under way.
 */
export function PinnedDocuments() {
  const t = useTranslation();
  const lang = useLocale();
  const { currentSpace } = useSpace();
  const { documentSlug: activeDocSlug } = useRoute();
  const { pinnedDocuments } = usePinnedDocuments();
  const { draggedDocument } = useDocumentDrag();

  // With nothing pinned there is no list to drop on, so a slim row stands in for
  // it. It appears just after the drag starts: Chrome cancels a drag whose
  // source moves during `dragstart`.
  const [showEmptyTarget, setShowEmptyTarget] = createSignal(false);
  createEffect(() => {
    if (!draggedDocument() || pinnedDocuments().length > 0) {
      setShowEmptyTarget(false);
      return;
    }
    const timer = setTimeout(() => setShowEmptyTarget(true), 50);
    onCleanup(() => clearTimeout(timer));
  });

  const collator = new Intl.Collator(lang, { numeric: true, sensitivity: "base" });

  const documents = createMemo(() =>
    [...pinnedDocuments()].sort(
      (left, right) =>
        pinnedOrder(left) - pinnedOrder(right) ||
        collator.compare(documentTitle(left, lang), documentTitle(right, lang)),
    ),
  );

  /** Writes `orderedIds` as the new order, pinning any document not yet pinned. */
  async function savePinnedOrder(orderedIds: string[]) {
    const space = currentSpace();
    if (!space) return;

    const current = new Map(documents().map((doc, index) => [doc.id, index]));
    await Promise.all(
      orderedIds.flatMap((id, index) => {
        if (current.get(id) === index && pinnedOrder(documents()[index]) === index) {
          return [];
        }
        return api.document.patch(space.id, id, {
          properties: {
            ...(current.has(id) ? {} : { pinned: { value: true } }),
            pinnedOrder: { value: index },
          },
        });
      }),
    );
  }

  async function handleDocumentCategoryChange(event: Event) {
    const { documentId, newCategoryId } = (event as CustomEvent).detail;
    if (newCategoryId !== PINNED_CATEGORY_ID) return;

    const space = currentSpace();
    if (!space) return;

    await savePinnedOrder([
      ...documents()
        .map((doc) => doc.id)
        .filter((id) => id !== documentId),
      documentId,
    ]);
  }

  async function handleDocumentReorder(event: Event) {
    const { documentId, targetDocumentId, placement } = (event as CustomEvent)
      .detail as { documentId: string; targetDocumentId: string; placement: Placement };
    if (documentId === targetDocumentId) return;

    const ids = documents()
      .map((doc) => doc.id)
      .filter((id) => id !== documentId);
    const targetIndex = ids.indexOf(targetDocumentId);
    if (targetIndex === -1) return;
    ids.splice(placement === "before" ? targetIndex : targetIndex + 1, 0, documentId);
    await savePinnedOrder(ids);
  }

  onMount(() => {
    window.addEventListener("document-category-change", handleDocumentCategoryChange);
    window.addEventListener("document-reorder", handleDocumentReorder);
    onCleanup(() => {
      window.removeEventListener(
        "document-category-change",
        handleDocumentCategoryChange,
      );
      window.removeEventListener("document-reorder", handleDocumentReorder);
    });
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a plain drop target, not a control.
    <category-target
      attr:data-category-id={PINNED_CATEGORY_ID}
      attr:data-space-id={currentSpace()?.id}
      class="flex flex-none flex-col gap-0.5 rounded-md px-3xs not-has-[page-target]:-mt-3xs [&[data-drag-over]]:outline-primary-500"
      classList={{
        "outline-2 -outline-offset-2 outline-neutral-400 outline-dashed":
          !!draggedDocument() && (pinnedDocuments().length > 0 || showEmptyTarget()),
      }}
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
              attr:data-reorderable=""
              class="block [&[data-dragging]]:opacity-50 [&[data-drop-placement=after]]:shadow-[0_1px_0_0_var(--color-neutral-400)] [&[data-drop-placement=before]]:shadow-[0_-1px_0_0_var(--color-neutral-400)]"
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
      <Show when={showEmptyTarget()}>
        <div class="flex min-h-[32px] items-center gap-1.5 @max-xs:justify-start rounded-md px-3xs text-neutral-500 text-size-normal">
          <Icon class="h-3.5 w-3.5 flex-none" name="pin-to-home" />
          <span class="@max-xs:hidden">{t("Pin document")}</span>
        </div>
      </Show>
    </category-target>
  );
}
