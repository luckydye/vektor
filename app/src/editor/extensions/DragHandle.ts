import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

type PositionStrategy = "absolute" | "fixed";

type ReferenceElement = {
  getBoundingClientRect(): DOMRect | ClientRect;
};

export type DragHandleOptions = {
  render: () => HTMLElement;
  computePositionConfig?: {
    strategy?: PositionStrategy;
  };
  getReferencedVirtualElement?: () => ReferenceElement | null;
  locked?: boolean;
  onNodeChange?: (options: {
    editor: Editor;
    node: ProseMirrorNode | null;
    pos: number;
  }) => void;
  onElementDragStart?: (event: DragEvent) => void;
  onElementDragEnd?: (event: DragEvent) => void;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    dragHandle: {
      lockDragHandle: () => ReturnType;
      unlockDragHandle: () => ReturnType;
      toggleDragHandle: () => ReturnType;
    };
  }
}

function topLevelBlockFromElement(view: EditorView, element: Element | null) {
  let current = element;

  while (current?.parentElement && current.parentElement !== view.dom) {
    current = current.parentElement;
  }

  return current?.parentElement === view.dom ? (current as HTMLElement) : null;
}

function blockAtPoint(view: EditorView, clientX: number, clientY: number) {
  const root = view.root as Document | ShadowRoot;
  for (const element of root.elementsFromPoint(clientX, clientY)) {
    if (!view.dom.contains(element)) continue;
    const block = topLevelBlockFromElement(view, element);
    if (block) return block;
  }

  let closestBlock: HTMLElement | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const child of view.dom.children) {
    if (!(child instanceof HTMLElement)) continue;
    const rect = child.getBoundingClientRect();
    const distance =
      clientY < rect.top
        ? rect.top - clientY
        : clientY > rect.bottom
          ? clientY - rect.bottom
          : 0;
    if (distance >= closestDistance) continue;
    closestBlock = child;
    closestDistance = distance;
  }

  return closestBlock;
}

function copyComputedStyles(source: HTMLElement, target: HTMLElement) {
  const sourceElements = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const targetElements = [target, ...target.querySelectorAll<HTMLElement>("*")];

  sourceElements.forEach((sourceElement, index) => {
    const targetElement = targetElements[index];
    if (!targetElement) return;

    const styles = getComputedStyle(sourceElement);
    for (let styleIndex = 0; styleIndex < styles.length; styleIndex++) {
      const property = styles.item(styleIndex);
      targetElement.style.setProperty(property, styles.getPropertyValue(property));
    }
  });
}

export const DragHandle = Extension.create<DragHandleOptions>({
  name: "dragHandle",

  addOptions() {
    return {
      render: () => {
        const element = document.createElement("div");
        element.classList.add("drag-handle");
        return element;
      },
      computePositionConfig: { strategy: "absolute" },
      getReferencedVirtualElement: undefined,
      locked: false,
      onNodeChange: undefined,
      onElementDragStart: undefined,
      onElementDragEnd: undefined,
    };
  },

  addCommands() {
    const setLocked = (locked: boolean) => {
      this.options.locked = locked;
      return this.editor.commands.setMeta("lockDragHandle", locked);
    };

    return {
      lockDragHandle: () => () => setLocked(true),
      unlockDragHandle: () => () => setLocked(false),
      toggleDragHandle: () => () => setLocked(!this.options.locked),
    };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const options = this.options;
    const element = options.render();
    const wrapper = document.createElement("div");
    const pluginKey = new PluginKey("dragHandle");

    let locked = options.locked ?? false;
    let currentNode: ProseMirrorNode | null = null;
    let currentNodePos = -1;
    let currentBlock: HTMLElement | null = null;
    let animationFrame: number | null = null;
    let pendingPointer: { x: number; y: number } | null = null;
    let dragPreview: HTMLElement | null = null;

    const notifyNodeChange = () => {
      options.onNodeChange?.({
        editor,
        node: currentNode,
        pos: currentNodePos,
      });
    };

    const hide = () => {
      element.style.visibility = "hidden";
      element.style.pointerEvents = "none";
    };

    const clearCurrentNode = () => {
      const changed = currentNode !== null || currentNodePos !== -1;
      currentNode = null;
      currentNodePos = -1;
      currentBlock = null;
      hide();
      if (changed) notifyNodeChange();
    };

    const positionHandle = (block: HTMLElement) => {
      const reference = options.getReferencedVirtualElement?.() ?? block;
      const rect = reference.getBoundingClientRect();
      const strategy = options.computePositionConfig?.strategy ?? "absolute";
      const handleRect = element.getBoundingClientRect();

      let left = rect.left - handleRect.width;
      let top = rect.top;

      if (strategy === "absolute") {
        const parentRect = wrapper.parentElement?.getBoundingClientRect();
        if (parentRect) {
          left -= parentRect.left;
          top -= parentRect.top;
        }
      }

      Object.assign(element.style, {
        position: strategy,
        left: `${Math.round(left)}px`,
        top: `${Math.round(top)}px`,
      });
    };

    const showForBlock = (view: EditorView, block: HTMLElement) => {
      if (!editor.isEditable) {
        clearCurrentNode();
        return;
      }

      let pos: number;
      try {
        pos = view.posAtDOM(block, 0);
      } catch {
        clearCurrentNode();
        return;
      }

      const node = view.state.doc.nodeAt(pos);
      if (!node) {
        clearCurrentNode();
        return;
      }

      const changed = node !== currentNode || pos !== currentNodePos;
      currentNode = node;
      currentNodePos = pos;
      currentBlock = block;

      if (changed) notifyNodeChange();
      if (currentNodePos !== pos) return;

      positionHandle(block);
      element.style.visibility = "";
      element.style.pointerEvents = "auto";
    };

    const removeDragPreview = () => {
      dragPreview?.remove();
      dragPreview = null;
    };

    const handleDragStart = (event: DragEvent) => {
      options.onElementDragStart?.(event);
      if (!event.dataTransfer || currentNodePos < 0 || !currentBlock) return;

      const { state, view } = editor;
      const node = state.doc.nodeAt(currentNodePos);
      if (!node || !NodeSelection.isSelectable(node)) return;

      const selection = NodeSelection.create(state.doc, currentNodePos);
      const slice = selection.content();
      const serialized = view.serializeForClipboard(slice);

      event.dataTransfer.clearData();
      event.dataTransfer.setData("text/html", serialized.dom.innerHTML);
      event.dataTransfer.setData("text/plain", serialized.text);
      event.dataTransfer.effectAllowed = "copyMove";

      const preview = currentBlock.cloneNode(true) as HTMLElement;
      copyComputedStyles(currentBlock, preview);
      preview.style.position = "fixed";
      preview.style.left = "-10000px";
      preview.style.top = "0";
      preview.style.width = `${currentBlock.getBoundingClientRect().width}px`;
      document.body.appendChild(preview);
      dragPreview = preview;
      event.dataTransfer.setDragImage(preview, 0, 0);

      view.dragging = { slice, move: true };
      view.dispatch(state.tr.setSelection(selection));
      setTimeout(() => {
        element.style.pointerEvents = "none";
      });
    };

    const handleDragEnd = (event: DragEvent) => {
      removeDragPreview();
      hide();
      element.style.pointerEvents = "auto";
      options.onElementDragEnd?.(event);
    };

    return [
      new Plugin({
        key: pluginKey,
        state: {
          init: () => ({ locked }),
          apply: (transaction) => {
            const nextLocked = transaction.getMeta("lockDragHandle");
            if (typeof nextLocked === "boolean") {
              locked = nextLocked;
              options.locked = nextLocked;
            }

            if (transaction.getMeta("hideDragHandle")) {
              locked = false;
              options.locked = false;
              clearCurrentNode();
            } else if (transaction.docChanged && currentNodePos >= 0) {
              currentNodePos = transaction.mapping.map(currentNodePos, -1);
            }

            return { locked };
          },
        },
        view: (view) => {
          wrapper.style.position = "absolute";
          wrapper.style.inset = "0";
          wrapper.style.pointerEvents = "none";
          element.draggable = !locked;
          hide();
          wrapper.appendChild(element);
          view.dom.parentElement?.appendChild(wrapper);

          element.addEventListener("dragstart", handleDragStart);
          element.addEventListener("dragend", handleDragEnd);

          return {
            update: (nextView, previousState) => {
              element.draggable = !locked;
              if (!editor.isEditable) {
                clearCurrentNode();
                return;
              }
              if (nextView.state.doc.eq(previousState.doc) || currentNodePos < 0) return;

              const dom = nextView.nodeDOM(currentNodePos);
              const block = topLevelBlockFromElement(
                nextView,
                dom instanceof Element ? dom : null,
              );
              if (block) showForBlock(nextView, block);
              else clearCurrentNode();
            },
            destroy: () => {
              if (animationFrame !== null) cancelAnimationFrame(animationFrame);
              element.removeEventListener("dragstart", handleDragStart);
              element.removeEventListener("dragend", handleDragEnd);
              removeDragPreview();
              wrapper.remove();
            },
          };
        },
        props: {
          handleDOMEvents: {
            keydown: (view) => {
              if (!locked && view.hasFocus()) clearCurrentNode();
              return false;
            },
            mouseleave: (_view, event) => {
              if (!locked && !wrapper.contains(event.relatedTarget as Node | null)) {
                clearCurrentNode();
              }
              return false;
            },
            mousemove: (view, event) => {
              if (locked) return false;

              pendingPointer = { x: event.clientX, y: event.clientY };
              if (animationFrame !== null) return false;

              animationFrame = requestAnimationFrame(() => {
                animationFrame = null;
                if (!pendingPointer) return;

                const { x, y } = pendingPointer;
                pendingPointer = null;
                const block = blockAtPoint(view, x, y);
                if (block) showForBlock(view, block);
                else clearCurrentNode();
              });

              return false;
            },
          },
        },
      }),
    ];
  },
});
