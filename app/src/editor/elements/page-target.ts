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
 * - data-dragging: Automatically added when this element is being dragged
 * - data-drag-over: Automatically added when another element is dragged over this one
 *
 * Events:
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

    connectedCallback() {
      this.setAttribute("draggable", "true");

      this.addEventListener("dragstart", this.handleDragStart.bind(this));
      this.addEventListener("dragend", this.handleDragEnd.bind(this));
      this.addEventListener("dragenter", this.handleDragEnter.bind(this));
      this.addEventListener("dragleave", this.handleDragLeave.bind(this));
      this.addEventListener("dragover", this.handleDragOver.bind(this));
      this.addEventListener("drop", this.handleDrop.bind(this));
    }

    disconnectedCallback() {
      this.removeEventListener("dragstart", this.handleDragStart.bind(this));
      this.removeEventListener("dragend", this.handleDragEnd.bind(this));
      this.removeEventListener("dragenter", this.handleDragEnter.bind(this));
      this.removeEventListener("dragleave", this.handleDragLeave.bind(this));
      this.removeEventListener("dragover", this.handleDragOver.bind(this));
      this.removeEventListener("drop", this.handleDrop.bind(this));
    }

    handleDragStart(e: DragEvent) {
      const documentId = this.getAttribute("data-document-id");
      if (!documentId) {
        throw new Error("Missing data-document-id attribute");
      }

      if (!e.dataTransfer) return;

      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/x-vektor-document-id", documentId);
      e.dataTransfer.setData("text/plain", documentId);
      this.setAttribute("data-dragging", "true");

      e.stopPropagation();
    }

    handleDragEnd(_e: DragEvent) {
      this.removeAttribute("data-dragging");
      this.removeAttribute("data-drag-over");
      this.dragCounter = 0;
    }

    handleDragEnter(e: DragEvent) {
      e.preventDefault();
      e.stopPropagation();

      this.dragCounter++;

      const isDraggingSelf = this.hasAttribute("data-dragging");
      if (isDraggingSelf) return;

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
      if (isDraggingSelf) {
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

      const draggedDocumentId = e.dataTransfer.getData("text/plain");
      const targetDocumentId = this.getAttribute("data-document-id");

      if (!draggedDocumentId || !targetDocumentId) {
        throw new Error("Missing document IDs");
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
