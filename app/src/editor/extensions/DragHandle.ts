import { type Editor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { NodeSelection, Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

type PositionStrategy = "absolute" | "fixed";

// The handle appears whenever the pointer is within this activation zone around
// the editor — the content plus a left gutter — so it tracks the nearest line by
// proximity instead of requiring a hover directly over a block. This also lets
// the pointer travel out into the gutter to grab the handle without it vanishing.
const ACTIVATION_GUTTER = 64;
const ACTIVATION_PAD = 8;

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

function isListElement(element: Element) {
  return element.nodeName === "UL" || element.nodeName === "OL";
}

// Resolve the block the drag handle should attach to. This is normally a
// direct child of the editor (a top-level block), but inside a list each
// individual list item is its own draggable unit — so the innermost <li>
// ancestor of the pointer wins over the enclosing list.
function draggableBlockFromElement(view: EditorView, element: Element | null) {
  let current = element;

  while (current && current !== view.dom) {
    if (current instanceof HTMLElement) {
      if (current.nodeName === "LI") return current;
      if (current.parentElement === view.dom) return current;
    }
    current = current.parentElement;
  }

  return null;
}

// Flatten the editor into the set of blocks the handle can attach to: top-level
// blocks, but lists are expanded into their (recursively nested) list items.
function collectDraggableBlocks(view: EditorView) {
  const blocks: HTMLElement[] = [];

  const walk = (parent: Element) => {
    for (const child of parent.children) {
      if (!(child instanceof HTMLElement)) continue;
      if (isListElement(child)) {
        walk(child);
      } else if (child.nodeName === "LI") {
        blocks.push(child);
        for (const nested of child.children) {
          if (nested instanceof HTMLElement && isListElement(nested)) {
            walk(nested);
          }
        }
      } else {
        blocks.push(child);
      }
    }
  };

  walk(view.dom);
  return blocks;
}

// Resolve the document position that starts the node rendered as `block`.
// `posAtDOM(block, 0)` is enough for top-level textblocks (it lands on the
// position before the node), but a list item is a block *container*, so that
// call lands inside it — before its inner paragraph. Walk up from there to the
// position of the <li> node itself so the whole item is selected, not its text.
function resolveBlockPos(view: EditorView, block: HTMLElement) {
  const insidePos = view.posAtDOM(block, 0);
  if (block.nodeName !== "LI") return insidePos;

  const $pos = view.state.doc.resolve(insidePos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const before = $pos.before(depth);
    if (view.nodeDOM(before) === block) return before;
  }

  return insidePos;
}

function blockAtPoint(view: EditorView, clientX: number, clientY: number) {
  const root = view.root as Document | ShadowRoot;
  for (const element of root.elementsFromPoint(clientX, clientY)) {
    if (!view.dom.contains(element)) continue;
    const block = draggableBlockFromElement(view, element);
    if (block) return block;
  }

  let closestBlock: HTMLElement | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;

  for (const child of collectDraggableBlocks(view)) {
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

      // Vertically center the handle on the block's first line of text (rather
      // than its top edge) so it lines up with the line the pointer is on.
      const style = getComputedStyle(block);
      const paddingTop = Number.parseFloat(style.paddingTop) || 0;
      let lineHeight = Number.parseFloat(style.lineHeight);
      if (Number.isNaN(lineHeight)) {
        lineHeight = (Number.parseFloat(style.fontSize) || 16) * 1.2;
      }

      // For list items, anchor to the left edge of the enclosing list so the
      // handle clears the bullet/number marker (which sits in the list's
      // padding) instead of covering it.
      let anchorLeft = rect.left;
      if (block.nodeName === "LI") {
        const list = block.closest("ul, ol");
        if (list) anchorLeft = list.getBoundingClientRect().left;
      }

      let left = anchorLeft - handleRect.width;
      let top = rect.top + paddingTop + lineHeight / 2 - handleRect.height / 2;

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
        pos = resolveBlockPos(view, block);
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

          // Proximity detection: the handle lives in a gutter outside the
          // editor DOM, so track the pointer globally and show the block nearest
          // the cursor whenever it is inside the editor's activation zone.
          const processPointer = (x: number, y: number) => {
            if (locked || !editor.isEditable) return;

            const rect = view.dom.getBoundingClientRect();
            const inZone =
              y >= rect.top - ACTIVATION_PAD &&
              y <= rect.bottom + ACTIVATION_PAD &&
              x >= rect.left - ACTIVATION_GUTTER &&
              x <= rect.right + ACTIVATION_PAD;

            if (!inZone) {
              clearCurrentNode();
              return;
            }

            const block = blockAtPoint(view, x, y);
            if (block) showForBlock(view, block);
            else clearCurrentNode();
          };

          const onDocumentMouseMove = (event: MouseEvent) => {
            pendingPointer = { x: event.clientX, y: event.clientY };
            if (animationFrame !== null) return;

            animationFrame = requestAnimationFrame(() => {
              animationFrame = null;
              if (!pendingPointer) return;
              const { x, y } = pendingPointer;
              pendingPointer = null;
              processPointer(x, y);
            });
          };

          // Listen on the editor's root node (the shadow root, or the document
          // when not in a shadow tree). Both the content and the left gutter
          // live inside it, and moves there — including the synthetic mousemove
          // document.ts dispatches on scroll — bubble up to it.
          const rootNode = view.dom.getRootNode() as Document | ShadowRoot;
          rootNode.addEventListener("mousemove", onDocumentMouseMove as EventListener, {
            passive: true,
          });

          return {
            update: (nextView, previousState) => {
              element.draggable = !locked;
              if (!editor.isEditable) {
                clearCurrentNode();
                return;
              }
              if (nextView.state.doc.eq(previousState.doc) || currentNodePos < 0) return;

              const dom = nextView.nodeDOM(currentNodePos);
              const block = draggableBlockFromElement(
                nextView,
                dom instanceof Element ? dom : null,
              );
              if (block) showForBlock(nextView, block);
              else clearCurrentNode();
            },
            destroy: () => {
              if (animationFrame !== null) cancelAnimationFrame(animationFrame);
              rootNode.removeEventListener(
                "mousemove",
                onDocumentMouseMove as EventListener,
              );
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
          },
        },
      }),
    ];
  },
});
