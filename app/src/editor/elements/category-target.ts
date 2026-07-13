import { parseVektorDocumentAddress } from "#utils/documentAddress.ts";

const DOCUMENT_LINK_MIME = "application/x-vektor-document-link";

/**
 * category-target
 *
 * A custom element that enables drag and drop functionality for categories.
 * This element acts as a drop target for page-target elements (documents).
 *
 * Usage:
 * ```html
 * <category-target
 *   data-category-id="cat-123"
 *   class="block [&[data-drag-over]]:bg-neutral-100"
 * >
 *   <div class="category-header">Your category content</div>
 * </category-target>
 * ```
 *
 * Attributes:
 * - data-category-id: Required. The unique ID of the category
 * - data-drag-over: Automatically added when a document is dragged over this category
 *
 * Events:
 * - document-category-change: Fired when a document is dropped onto this category
 *   detail: { documentId: string, newCategoryId: string }
 *
 * Example event handling:
 * ```javascript
 * window.addEventListener('document-category-change', (e) => {
 *   const { documentId, newCategoryId } = e.detail;
 *   // Update document category in your database
 * });
 * ```
 */
customElements.define(
  "category-target",
  class extends HTMLElement {
    dragCounter = 0;

    private readonly onDragEnter = this.handleDragEnter.bind(this);
    private readonly onDragLeave = this.handleDragLeave.bind(this);
    private readonly onDragOver = this.handleDragOver.bind(this);
    private readonly onDrop = this.handleDrop.bind(this);

    connectedCallback() {
      this.addEventListener("dragenter", this.onDragEnter);
      this.addEventListener("dragleave", this.onDragLeave);
      this.addEventListener("dragover", this.onDragOver);
      this.addEventListener("drop", this.onDrop);
    }

    disconnectedCallback() {
      this.removeEventListener("dragenter", this.onDragEnter);
      this.removeEventListener("dragleave", this.onDragLeave);
      this.removeEventListener("dragover", this.onDragOver);
      this.removeEventListener("drop", this.onDrop);
    }

    handleDragEnter(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();

      this.dragCounter++;
      this.setAttribute("data-drag-over", "true");
    }

    handleDragLeave(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();

      this.dragCounter--;

      if (this.dragCounter === 0) {
        this.removeAttribute("data-drag-over");
      }
    }

    handleDragOver(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();

      if (!e.dataTransfer) return;
      e.dataTransfer.dropEffect = "move";
    }

    handleDrop(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();

      this.removeAttribute("data-drag-over");
      this.dragCounter = 0;

      if (!e.dataTransfer) return;

      const structured = e.dataTransfer.getData(DOCUMENT_LINK_MIME);
      let payload: { address?: unknown; documentId?: unknown } | null = null;
      try {
        payload = structured.trim()
          ? (JSON.parse(structured) as { address?: unknown; documentId?: unknown })
          : null;
      } catch {
        return;
      }

      const parsedAddress =
        typeof payload?.address === "string"
          ? parseVektorDocumentAddress(payload.address)
          : null;
      const draggedDocumentId =
        typeof payload?.documentId === "string" ? payload.documentId : null;
      const targetCategoryId = this.getAttribute("data-category-id");
      const targetSpaceId = this.getAttribute("data-space-id");

      if (!draggedDocumentId || !targetCategoryId || !parsedAddress) {
        throw new Error("Missing document or category ID");
      }
      if (
        parsedAddress.origin !== window.location.origin ||
        (targetSpaceId && parsedAddress.spaceId !== targetSpaceId)
      ) {
        return;
      }

      this.dispatchEvent(
        new CustomEvent("document-category-change", {
          bubbles: true,
          composed: true,
          detail: {
            documentId: draggedDocumentId,
            newCategoryId: targetCategoryId,
          },
        }),
      );
    }
  },
);
