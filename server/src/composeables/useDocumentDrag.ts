import { createSignal, onCleanup, onMount } from "solid-js";

/**
 * The document currently being dragged from a `page-target` element, or null
 * when no drag is in progress. Mirrors the `document-drag-start` /
 * `document-drag-end` events the element dispatches on the window, so views
 * can react to a drag they did not start (e.g. dim invalid drop targets).
 */
const [draggedDocument, setDraggedDocument] = createSignal<{
  id: string;
  type: string | null;
} | null>(null);

function handleDragStart(event: Event) {
  const detail = (event as CustomEvent).detail as {
    documentId?: string;
    documentType?: string | null;
  };
  if (!detail?.documentId) return;
  setDraggedDocument({ id: detail.documentId, type: detail.documentType ?? null });
}

function handleDragEnd() {
  setDraggedDocument(null);
}

// Listeners are shared: the tree renders one component per document, and they
// all observe the same drag.
let subscribers = 0;

export function useDocumentDrag() {
  onMount(() => {
    subscribers += 1;
    if (subscribers > 1) return;
    window.addEventListener("document-drag-start", handleDragStart);
    window.addEventListener("document-drag-end", handleDragEnd);
  });

  // `onMount`'s body never runs during SSR, but Solid still runs `onCleanup`
  // callbacks when the server render disposes its node tree — so this must not
  // assume the mount above ever happened, and must not touch `window`.
  onCleanup(() => {
    if (typeof window === "undefined") return;
    subscribers -= 1;
    if (subscribers > 0) return;
    window.removeEventListener("document-drag-start", handleDragStart);
    window.removeEventListener("document-drag-end", handleDragEnd);
    setDraggedDocument(null);
  });

  return { draggedDocument: draggedDocument };
}
