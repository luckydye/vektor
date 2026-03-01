// Reusable resize handle utilities for TipTap node views
//
// Usage:
//   import { ResizableNodeView } from "./resizable.ts";
//
//   class MyResizableView extends ResizableNodeView {
//     constructor(node, view, getPos) {
//       super(node, view, getPos);
//       // Create your content element
//       const content = document.createElement("div");
//       // Use 'width' mode for aspect ratio (images), 'height' mode for height-only (embeds)
//       this.setupResizableContent(content, 'width');
//     }
//
//     updateContent() {
//       // Update your content element based on this.node.attrs
//     }
//   }

import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView, EditorView } from "@tiptap/pm/view";

export interface ResizableAttrs {
  width?: number | null;
  height?: number | null;
  display?: "full" | null;
}

export type ResizeMode = "width" | "height";

export abstract class ResizableNodeView implements NodeView {
  dom: HTMLElement;
  contentEl?: HTMLElement;
  handle?: HTMLElement;
  node: ProseMirrorNode;
  view: EditorView;
  getPos: () => number | undefined;

  isResizing = false;
  startX = 0;
  startY = 0;
  startWidth = 0;
  startHeight = 0;
  aspectRatio?: number;
  resizeMode: ResizeMode = "width";

  constructor(node: ProseMirrorNode, view: EditorView, getPos: () => number | undefined) {
    this.node = node;
    this.view = view;
    this.getPos = getPos;

    this.dom = document.createElement("div");
    this.dom.style.display = "inline-block";
    this.dom.style.position = "relative";
    this.dom.style.maxWidth = "100%";
  }

  setupResizableContent(contentEl: HTMLElement, mode: ResizeMode): void {
    this.contentEl = contentEl;
    this.resizeMode = mode;

    if (mode === "width") {
      this.aspectRatio = contentEl.offsetWidth / contentEl.offsetHeight || 16 / 9;
    }

    if (mode === "height") {
      this.dom.style.width = "100%";
    }

    this.dom.appendChild(contentEl);
    this.updateSize();
  }

  selectNode(): void {
    this.dom.classList.add("ProseMirror-selectednode");

    if (this.node.attrs.display !== "full" && !this.handle) {
      this.handle = document.createElement("div");
      this.handle.classList.add("resize-handle");
      this.handle.style.position = "absolute";
      this.handle.style.right = "-4px";
      this.handle.style.bottom = "-4px";
      this.handle.style.width = "12px";
      this.handle.style.height = "12px";
      this.handle.style.background = "#3b82f6";
      this.handle.style.border = "2px solid white";
      this.handle.style.borderRadius = "2px";
      this.handle.style.cursor =
        this.resizeMode === "height" ? "ns-resize" : "nwse-resize";
      this.handle.style.zIndex = "10";

      this.handle.addEventListener("mousedown", this.handleMouseDown);
      this.dom.appendChild(this.handle);
    }
  }

  deselectNode(): void {
    this.dom.classList.remove("ProseMirror-selectednode");

    if (this.handle) {
      this.handle.removeEventListener("mousedown", this.handleMouseDown);
      this.handle.remove();
      this.handle = undefined;
    }
  }

  updateSize(): void {
    if (!this.contentEl) return;

    this.contentEl.style.pointerEvents = "none";

    if (this.node.attrs.display === "full") {
      this.contentEl.style.width = "100%";
      this.contentEl.style.height = "auto";
    } else if (this.resizeMode === "height" && this.node.attrs.height) {
      this.contentEl.style.height = `${this.node.attrs.height}px`;
      this.contentEl.style.width = "100%";
    } else if (this.resizeMode === "width" && this.node.attrs.width) {
      this.contentEl.style.width = `${this.node.attrs.width}px`;
      this.contentEl.style.height = "auto";
    }
  }

  handleMouseDown = (e: MouseEvent): void => {
    e.preventDefault();
    e.stopPropagation();

    if (!this.contentEl) return;

    this.isResizing = true;
    this.startX = e.clientX;
    this.startY = e.clientY;
    this.startWidth = this.contentEl.offsetWidth;
    this.startHeight = this.contentEl.offsetHeight;

    if (this.resizeMode === "width" && this.startHeight > 0) {
      this.aspectRatio = this.startWidth / this.startHeight;
    }

    document.addEventListener("mousemove", this.handleMouseMove);
    document.addEventListener("mouseup", this.handleMouseUp);
  };

  handleMouseMove = (e: MouseEvent): void => {
    if (!this.isResizing || !this.contentEl) return;

    if (this.resizeMode === "height") {
      const deltaY = e.clientY - this.startY;
      const newHeight = this.startHeight + deltaY;

      if (newHeight > 100 && newHeight < 2000) {
        this.contentEl.style.height = `${newHeight}px`;
      }
    } else {
      const deltaX = e.clientX - this.startX;
      const newWidth = this.startWidth + deltaX;

      if (newWidth > 50 && newWidth < 2000) {
        this.contentEl.style.width = `${newWidth}px`;
        this.contentEl.style.height = "auto";
      }
    }
  };

  handleMouseUp = (): void => {
    if (!this.isResizing || !this.contentEl) return;

    this.isResizing = false;

    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);

    const pos = this.getPos();
    if (pos !== undefined) {
      const attrs: ResizableAttrs = {
        ...this.node.attrs,
        display: null,
      };

      if (this.resizeMode === "height") {
        attrs.height = this.contentEl.offsetHeight;
      } else {
        attrs.width = this.contentEl.offsetWidth;
      }

      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, null, attrs));
    }
  };

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type) {
      return false;
    }

    this.node = node;
    this.updateSize();
    this.updateContent();

    return true;
  }

  abstract updateContent(): void;

  destroy(): void {
    if (this.handle) {
      this.handle.removeEventListener("mousedown", this.handleMouseDown);
    }
    document.removeEventListener("mousemove", this.handleMouseMove);
    document.removeEventListener("mouseup", this.handleMouseUp);
  }

  stopEvent(event: Event): boolean {
    return (
      event.type === "mousedown" &&
      (event.target as HTMLElement).classList.contains("resize-handle")
    );
  }

  ignoreMutation(): boolean {
    return true;
  }
}

export function createResizableAttributes() {
  return {
    width: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        element.getAttribute("width") || element.style.width || null,
      renderHTML: (attributes: ResizableAttrs) => {
        if (!attributes.width) {
          return {};
        }
        return {
          width: attributes.width,
          style: `width: ${attributes.width}${typeof attributes.width === "number" ? "px" : ""}`,
        };
      },
    },
    height: {
      default: null,
      parseHTML: (element: HTMLElement) =>
        element.getAttribute("height") || element.style.height || null,
      renderHTML: (attributes: ResizableAttrs) => {
        if (!attributes.height) {
          return {};
        }
        return {
          height: attributes.height,
        };
      },
    },
    display: {
      default: null,
      parseHTML: (element: HTMLElement) => element.getAttribute("data-display") || null,
      renderHTML: (attributes: ResizableAttrs) => {
        if (!attributes.display) {
          return {};
        }
        const styles: string[] = [];
        if (attributes.display === "full") {
          styles.push("width: 100%");
        }
        return {
          "data-display": attributes.display,
          style: styles.join("; "),
        };
      },
    },
  };
}
