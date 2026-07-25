import {
  createVektorDocumentAddress,
  parseVektorDocumentAddress,
} from "#documents/address.ts";
import { allowsChildDocumentType } from "#documents/types.ts";

const DOCUMENT_LINK_MIME = "application/x-vektor-document-link";

/**
 * The document currently being dragged in this window. `dataTransfer` is in
 * protected mode during dragenter/dragover (only MIME types are readable), so
 * the dragged document's type is kept here to decide whether a target may
 * accept it. Drags originating from another window leave this null; those
 * fall back to permissive local behaviour and are rejected server-side.
 */
let activeDrag: { documentId: string; documentType: string | null } | null = null;

/**
 * page-target
 *
 * A custom element that enables drag and drop functionality for document tree items.
 * Each element can be dragged and also acts as a drop target for other elements.
 *
 * Usage:
 * ```html
 * <page-target
 *   data-document-id="doc-123"
 *   class="block [&[data-drag-over]]:bg-blue-100 [&[data-dragging]]:opacity-50"
 * >
 *   <div class="document-item">Your document content</div>
 * </page-target>
 * ```
 *
 * Attributes:
 * - data-document-id: Required. The unique ID of the document
 * - data-document-type: Optional. The document's type, used to decide which
 *   documents this one may parent (see `allowedChildDocumentTypes`)
 * - data-dragging: Automatically added when this element is being dragged
 * - data-drag-over: Automatically added when another element is dragged over this one
 *
 * Events:
 * - document-drag-start: Fired when this document starts being dragged
 *   detail: { documentId: string, documentType: string | null }
 * - document-drag-end: Fired when the drag finishes (dropped or cancelled)
 *   detail: { documentId: string }
 * - document-parent-change: Fired when a document is dropped onto this element
 *   detail: { documentId: string, newParentId: string }
 *
 * Example event handling:
 * ```javascript
 * window.addEventListener('document-parent-change', (e) => {
 *   const { documentId, newParentId } = e.detail;
 *   // Update document parent in your database
 * });
 * ```
 */
customElements.define(
  "page-target",
  class extends HTMLElement {
    dragCounter = 0;

    private readonly onDragStart = this.handleDragStart.bind(this);
    private readonly onDragEnd = this.handleDragEnd.bind(this);
    private readonly onDragEnter = this.handleDragEnter.bind(this);
    private readonly onDragLeave = this.handleDragLeave.bind(this);
    private readonly onDragOver = this.handleDragOver.bind(this);
    private readonly onDrop = this.handleDrop.bind(this);

    connectedCallback() {
      this.setAttribute("draggable", "true");

      this.addEventListener("dragstart", this.onDragStart);
      this.addEventListener("dragend", this.onDragEnd);
      this.addEventListener("dragenter", this.onDragEnter);
      this.addEventListener("dragleave", this.onDragLeave);
      this.addEventListener("dragover", this.onDragOver);
      this.addEventListener("drop", this.onDrop);
    }

    disconnectedCallback() {
      this.removeEventListener("dragstart", this.onDragStart);
      this.removeEventListener("dragend", this.onDragEnd);
      this.removeEventListener("dragenter", this.onDragEnter);
      this.removeEventListener("dragleave", this.onDragLeave);
      this.removeEventListener("dragover", this.onDragOver);
      this.removeEventListener("drop", this.onDrop);
    }

    handleDragStart(e: DragEvent) {
      const documentId = this.getAttribute("data-document-id");
      if (!documentId) {
        throw new Error("Missing data-document-id attribute");
      }
      const spaceId = this.getAttribute("data-space-id") || undefined;
      const url = this.getAttribute("data-document-url") || undefined;
      const address =
        this.getAttribute("data-document-address") ||
        (spaceId
          ? createVektorDocumentAddress({
              origin: url
                ? new URL(url, window.location.origin).origin
                : window.location.origin,
              spaceId,
              documentId,
              href: url ? new URL(url, window.location.origin).href : undefined,
            })
          : undefined);
      if (!address) {
        throw new Error("Missing document address");
      }

      if (!e.dataTransfer) return;

      const documentType = this.getAttribute("data-document-type") || null;
      activeDrag = { documentId, documentType };

      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData(
        DOCUMENT_LINK_MIME,
        JSON.stringify({
          address,
          type: documentType,
        }),
      );
      if (url) {
        e.dataTransfer.setData("text/plain", new URL(url, window.location.origin).href);
      }
      this.setAttribute("data-dragging", "true");

      this.dispatchEvent(
        new CustomEvent("document-drag-start", {
          bubbles: true,
          composed: true,
          detail: { documentId, documentType },
        }),
      );

      e.stopPropagation();
    }

    handleDragEnd(_e: DragEvent) {
      const documentId = this.getAttribute("data-document-id");
      activeDrag = null;
      this.removeAttribute("data-dragging");
      this.removeAttribute("data-drag-over");
      this.dragCounter = 0;

      this.dispatchEvent(
        new CustomEvent("document-drag-end", {
          bubbles: true,
          composed: true,
          detail: { documentId },
        }),
      );
    }

    /**
     * Whether this document may become the parent of the dragged one. Unknown
     * drags (from another window) are treated as allowed — the API has the
     * final say.
     */
    acceptsActiveDrag() {
      if (!activeDrag) return true;
      return allowsChildDocumentType(
        this.getAttribute("data-document-type"),
        activeDrag.documentType,
      );
    }

    handleDragEnter(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();

      this.dragCounter++;

      const isDraggingSelf = this.hasAttribute("data-dragging");
      if (isDraggingSelf || !this.acceptsActiveDrag()) return;

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

      const isDraggingSelf = this.hasAttribute("data-dragging");
      if (isDraggingSelf || !this.acceptsActiveDrag()) {
        e.dataTransfer.dropEffect = "none";
        return;
      }

      e.dataTransfer.dropEffect = "move";
    }

    handleDrop(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();

      this.removeAttribute("data-drag-over");
      this.dragCounter = 0;

      const isDraggingSelf = this.hasAttribute("data-dragging");
      if (isDraggingSelf) return;

      if (!e.dataTransfer) return;

      const structured = e.dataTransfer.getData(DOCUMENT_LINK_MIME);
      let address: unknown = null;
      let draggedType: string | null = null;
      try {
        const payload =
          typeof structured === "string" && structured.trim()
            ? (JSON.parse(structured) as { address?: unknown; type?: unknown })
            : null;
        address = payload?.address ?? null;
        draggedType = typeof payload?.type === "string" ? payload.type : null;
      } catch {
        return;
      }

      if (
        !allowsChildDocumentType(this.getAttribute("data-document-type"), draggedType)
      ) {
        return;
      }
      const parsedAddress =
        typeof address === "string" ? parseVektorDocumentAddress(address) : null;
      const draggedDocumentId = parsedAddress?.documentId;
      const targetDocumentId = this.getAttribute("data-document-id");
      const targetSpaceId = this.getAttribute("data-space-id");

      if (!draggedDocumentId || !targetDocumentId || !parsedAddress) {
        throw new Error("Missing document IDs");
      }
      if (
        parsedAddress.origin !== window.location.origin ||
        (targetSpaceId && parsedAddress.spaceId !== targetSpaceId)
      ) {
        return;
      }

      if (draggedDocumentId === targetDocumentId) return;

      this.dispatchEvent(
        new CustomEvent("document-parent-change", {
          bubbles: true,
          composed: true,
          detail: {
            documentId: draggedDocumentId,
            newParentId: targetDocumentId,
          },
        }),
      );
    }
  },
);
