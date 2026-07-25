import { onMounted, onUnmounted, readonly, ref } from "vue";

/**
 * The document currently being dragged from a `page-target` element, or null
 * when no drag is in progress. Mirrors the `document-drag-start` /
 * `document-drag-end` events the element dispatches on the window, so views
 * can react to a drag they did not start (e.g. dim invalid drop targets).
 */
const draggedDocument = ref<{ id: string; type: string | null } | null>(null);

function handleDragStart(event: Event) {
  const detail = (event as CustomEvent).detail as {
    documentId?: string;
    documentType?: string | null;
  };
  if (!detail?.documentId) return;
  draggedDocument.value = { id: detail.documentId, type: detail.documentType ?? null };
}

function handleDragEnd() {
  draggedDocument.value = null;
}

// Listeners are shared: the tree renders one component per document, and they
// all observe the same drag.
let subscribers = 0;

export function useDocumentDrag() {
  onMounted(() => {
    subscribers += 1;
    if (subscribers > 1) return;
    window.addEventListener("document-drag-start", handleDragStart);
    window.addEventListener("document-drag-end", handleDragEnd);
  });

  onUnmounted(() => {
    subscribers -= 1;
    if (subscribers > 0) return;
    window.removeEventListener("document-drag-start", handleDragStart);
    window.removeEventListener("document-drag-end", handleDragEnd);
    draggedDocument.value = null;
  });

  return { draggedDocument: readonly(draggedDocument) };
}
