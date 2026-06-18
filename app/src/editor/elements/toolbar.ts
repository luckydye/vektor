import type { Editor } from "@tiptap/core";
import "@sv/elements/popover";
import { html, render } from "lit-html";
import {
  alignCenterIcon,
  alignJustifyIcon,
  alignLeftIcon,
  alignRightIcon,
  boldIcon,
  cellMergeIcon,
  chevronDownIcon,
  closeThickIcon,
  columnDeleteIcon,
  columns2Icon,
  columns3Icon,
  columns4Icon,
  commentIcon,
  expressionCellIcon,
  highlightIcon,
  imageFullWidthIcon,
  indentIcon,
  italicIcon,
  linkIcon,
  listCheckIcon,
  listOrderedIcon,
  listUnorderedIcon,
  moreIcon,
  outdentIcon,
  pasteIcon,
  plusOverlayIcon,
  restoreArrowIcon,
  rowDeleteIcon,
  scissorsIcon,
  strikethroughIcon,
  tableColumnAddAfterIcon,
  tableColumnAddBeforeIcon,
  tableDeleteIcon,
  tableHeaderCellIcon,
  tableRowAddAfterIcon,
  tableRowIcon,
  tableSplitCellIcon,
  textColorIcon,
  underlineIcon,
} from "../../assets/icons.ts";

/**
 * Resolve the currently selected image node, or null if no image is selected
 */
function getSelectedImageNode(editor: Editor) {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;

  const node =
    $from.parent.type.name === "image" ? $from.parent : state.doc.nodeAt(selection.from);

  return node?.type.name === "image" ? node : null;
}

/**
 * Toggle full-width display for the currently selected image
 * Switches between full-width (100%) and original size
 *
 * @example
 * // Toggle full-width on/off
 * toggleImageFullWidth(editor);
 *
 * @example
 * // Use in a toolbar button
 * <button onclick={() => toggleImageFullWidth(globalThis.__editor)}>
 *   Toggle Full Width
 * </button>
 *
 * @example
 * // Use with keyboard shortcut (Alt + F)
 * editor.on('keydown', (event) => {
 *   if (event.altKey && event.key === 'f' && isImageSelected(editor)) {
 *     event.preventDefault();
 *     toggleImageFullWidth(editor);
 *   }
 * });
 */
function toggleImageFullWidth(editor: Editor) {
  const node = getSelectedImageNode(editor);

  if (!node) {
    return false;
  }

  const currentDisplay = node.attrs.display;
  const newDisplay = currentDisplay === "full" ? null : "full";

  return editor.commands.updateAttributes("image", {
    display: newDisplay,
    width: null, // Clear width when setting display mode
  });
}

/**
 * Reset image to its original size (removes width and display attributes)
 *
 * @example
 * resetImageSize(editor);
 *
 * @example
 * // Use with keyboard shortcut (Alt + R)
 * editor.on('keydown', (event) => {
 *   if (event.altKey && event.key === 'r' && isImageSelected(editor)) {
 *     event.preventDefault();
 *     resetImageSize(editor);
 *   }
 * });
 */
function resetImageSize(editor: Editor) {
  return editor.commands.updateAttributes("image", {
    width: null,
    display: null,
  });
}

/**
 * Check if the currently selected node is an image
 * Useful for enabling/disabling image-related toolbar buttons
 *
 * @example
 * if (isImageSelected(editor)) {
 *   console.log("An image is selected!");
 * }
 *
 * @example
 * // Disable toolbar button when no image is selected
 * <button
 *   disabled={!isImageSelected(editor)}
 *   onclick={() => toggleImageFullWidth(editor)}
 * >
 *   Full Width
 * </button>
 */
export function isImageSelected(editor: Editor): boolean {
  return getSelectedImageNode(editor) !== null;
}

/**
 * Get the current image attributes (width, display, src, etc.)
 * Returns null if no image is selected
 *
 * @example
 * const attrs = getImageAttributes(editor);
 * if (attrs) {
 *   console.log("Width:", attrs.width);
 *   console.log("Display:", attrs.display);
 *   console.log("Source:", attrs.src);
 * }
 *
 * @example
 * // Show current image dimensions in UI
 * const attrs = getImageAttributes(editor);
 * const statusText = attrs
 *   ? `${attrs.display === 'full' ? 'Full Width' : attrs.width || 'Auto'}`
 *   : 'No image selected';
 *
 * @example
 * // Programmatically resize all images in document
 * function resizeAllImages(editor, width) {
 *   const { state } = editor;
 *   let tr = state.tr;
 *
 *   state.doc.descendants((node, pos) => {
 *     if (node.type.name === 'image') {
 *       tr = tr.setNodeMarkup(pos, null, {
 *         ...node.attrs,
 *         width: width,
 *         display: null
 *       });
 *     }
 *   });
 *
 *   editor.view.dispatch(tr);
 * }
 */
export function getImageAttributes(editor: Editor) {
  return getSelectedImageNode(editor)?.attrs ?? null;
}

declare global {
  interface Window {
    __editor?: Editor;
  }
}

function getEditor() {
  return window.__editor;
}

function editorReady(editor: Editor | undefined): editor is Editor {
  return !!editor && !editor.isDestroyed;
}

if (
  typeof customElements !== "undefined" &&
  typeof HTMLElement !== "undefined" &&
  !customElements.get("document-toolbar")
) {
  customElements.define(
    "document-toolbar",
    class DocumentToolbarElement extends HTMLElement {
      private root: ShadowRoot;
      private shouldShow = false;
      private interacting = false;
      private secondaryOpen = false;
      private headingLevel = 0;
      private inColumnLayout = false;
      private columnCount = 2;
      private imageActive = false;
      private imageDisplay: string | null = null;
      private textColor = "#000000";
      private bgColor = "transparent";
      private tableActive = false;
      private cellBackgroundColor = "transparent";
      private copiedRow: unknown = null;
      private floatingStyle = "";
      private tableStyle = "";
      private dismissedSelectionKey: string | null = null;

      constructor() {
        super();
        this.root = this.attachShadow({ mode: "open" });
      }

      connectedCallback() {
        window.addEventListener("document:edit", this.handleEditorAvailable);
        window.addEventListener("editor-ready", this.handleEditorAvailable);
        window.addEventListener("edit-mode-start", this.handleEditorAvailable);
        window.addEventListener("edit-mode-cancel", this.handleEditModeEnd);
        window.addEventListener("editor-destroyed", this.handleEditModeEnd);
        window.addEventListener("editor-update", this.update);
        window.addEventListener("resize", this.updatePosition, { passive: true });
        document.addEventListener("pointerup", this.handlePointerUp);
        document.addEventListener("scroll", this.updatePosition, {
          passive: true,
          capture: true,
        });

        this.handleEditorAvailable();
        this.paint();
      }

      disconnectedCallback() {
        window.removeEventListener("document:edit", this.handleEditorAvailable);
        window.removeEventListener("editor-ready", this.handleEditorAvailable);
        window.removeEventListener("edit-mode-start", this.handleEditorAvailable);
        window.removeEventListener("edit-mode-cancel", this.handleEditModeEnd);
        window.removeEventListener("editor-destroyed", this.handleEditModeEnd);
        window.removeEventListener("editor-update", this.update);
        window.removeEventListener("resize", this.updatePosition);
        document.removeEventListener("pointerup", this.handlePointerUp);
        document.removeEventListener("scroll", this.updatePosition);
      }

      private get menu() {
        return this.root.querySelector<HTMLElement>(".floating-menu");
      }

      private get tableMenu() {
        return this.root.querySelector<HTMLElement>(".table-toolbar");
      }

      private get textColorInput() {
        return this.root.querySelector<HTMLInputElement>("[data-text-color]");
      }

      private get bgColorInput() {
        return this.root.querySelector<HTMLInputElement>("[data-bg-color]");
      }

      private get cellBgColorInput() {
        return this.root.querySelector<HTMLInputElement>("[data-cell-bg-color]");
      }

      private handleEditorAvailable = () => {
        this.update();
      };

      private handleEditModeEnd = () => {
        this.shouldShow = false;
        this.tableActive = false;
        this.secondaryOpen = false;
        this.interacting = false;
        this.imageActive = false;
        this.dismissedSelectionKey = null;
        this.paint();
      };

      dismiss() {
        const editor = getEditor();
        if (editorReady(editor)) {
          this.dismissedSelectionKey = this.toolbarSelectionKey(editor);
        }
        this.shouldShow = false;
        this.tableActive = false;
        this.secondaryOpen = false;
        this.interacting = false;
        this.paint();
      }

      openTextColorPicker() {
        this.textColorInput?.click();
      }

      openBackgroundColorPicker() {
        this.bgColorInput?.click();
      }

      private handlePointerUp = (event: PointerEvent) => {
        const target = event.target;
        const targetNode = target instanceof Node ? target : null;
        if (targetNode && this.menu?.contains(targetNode)) return;
        if (targetNode && this.tableMenu?.contains(targetNode)) return;

        window.setTimeout(() => {
          this.interacting = false;
          this.paint();
        }, 100);
      };

      private update = () => {
        const editor = getEditor();
        if (!editorReady(editor)) {
          this.shouldShow = false;
          this.secondaryOpen = false;
          this.tableActive = false;
          this.paint();
          return;
        }

        this.inColumnLayout = editor.isActive("columnLayout");
        this.imageActive = isImageSelected(editor);
        this.tableActive = editor.isActive("table");
        this.updateHeadingLevel(editor);
        this.updateColors(editor);
        this.updateColumnInfo(editor);
        this.updateImageInfo(editor);
        this.updateCellBackground(editor);

        const wasShowing = this.shouldShow;
        const selectionKey = this.toolbarSelectionKey(editor);
        if (this.dismissedSelectionKey && this.dismissedSelectionKey !== selectionKey) {
          this.dismissedSelectionKey = null;
        }
        let nextShouldShow = false;

        if (this.inColumnLayout || this.imageActive) {
          nextShouldShow = true;
        } else {
          const { from, to } = editor.state.selection;
          const selectedText = editor.state.doc.textBetween(from, to, " ");
          nextShouldShow = from !== to && selectedText.trim().length > 0;
        }

        if (nextShouldShow && this.dismissedSelectionKey === selectionKey) {
          nextShouldShow = false;
          this.tableActive = false;
        }

        if (!wasShowing || !nextShouldShow) {
          this.secondaryOpen = false;
        }

        this.shouldShow = nextShouldShow;

        if (!this.shouldShow) {
        }

        this.updatePosition();
      };

      private toolbarSelectionKey(editor: Editor) {
        const { from, to } = editor.state.selection;
        return [
          from,
          to,
          editor.isActive("columnLayout") ? "columns" : "",
          isImageSelected(editor) ? "image" : "",
          editor.isActive("table") ? "table" : "",
        ].join(":");
      }

      private updatePosition = () => {
        const editor = getEditor();
        if (!editorReady(editor)) return;

        if (this.shouldShow) {
          const { state, view } = editor;
          const left = this.leftAlignedToolbarPosition(
            editor,
            this.menu?.offsetWidth ?? 600,
          );
          const top = this.verticalToolbarPosition(
            editor,
            Math.max(this.menu?.offsetHeight ?? 48, 48),
          );
          this.floatingStyle = `left:${left}px;top:${top}px;`;
        }

        if (this.tableActive) {
          this.tableStyle = this.getTableStyle(editor);
        } else {
          this.tableStyle = "";
        }

        this.paint();
      };

      private getTableStyle(editor: Editor) {
        const { state, view } = editor;
        const { from } = state.selection;
        const $from = state.doc.resolve(from);
        let tableDepth: number | null = null;

        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name === "table") {
            tableDepth = depth;
            break;
          }
        }

        if (tableDepth === null) return "";

        const coords = view.coordsAtPos($from.before(tableDepth));
        const left = this.leftAlignedToolbarPosition(
          editor,
          this.tableMenu?.offsetWidth ?? 400,
        );
        return `left:${left}px;top:${coords.top}px;`;
      }

      private leftAlignedToolbarPosition(editor: Editor, toolbarWidth: number) {
        const padding = 8;
        const editorLeft = editor.view.dom.getBoundingClientRect().left;
        const maxLeft = window.innerWidth - toolbarWidth - padding;
        return Math.min(Math.max(editorLeft, padding), Math.max(padding, maxLeft));
      }

      private verticalToolbarPosition(editor: Editor, toolbarHeight: number) {
        const padding = 8;
        const gap = 10;
        const { from, to } = editor.state.selection;
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        const selectionTop = Math.min(start.top, end.top);
        const selectionBottom = Math.max(start.bottom, end.bottom);
        const topCandidate = selectionTop - toolbarHeight - gap;
        const bottomCandidate = selectionBottom + gap;
        const maxTop = window.innerHeight - toolbarHeight - padding;

        if (topCandidate >= padding) {
          return topCandidate;
        }

        if (bottomCandidate <= maxTop) {
          return bottomCandidate;
        }

        return Math.min(Math.max(topCandidate, padding), Math.max(padding, maxTop));
      }

      private updateHeadingLevel(editor: Editor) {
        for (let level = 1; level <= 6; level++) {
          if (editor.isActive("heading", { level })) {
            this.headingLevel = level;
            return;
          }
        }
        this.headingLevel = 0;
      }

      private updateColors(editor: Editor) {
        const attrs = editor.getAttributes("textStyle");
        this.textColor = attrs.color || "#000000";
        this.bgColor = attrs.backgroundColor || "transparent";
      }

      private updateColumnInfo(editor: Editor) {
        if (!this.inColumnLayout) return;
        this.columnCount = editor.getAttributes("columnLayout").columns || 2;
      }

      private updateImageInfo(editor: Editor) {
        if (!this.imageActive) return;
        const attrs = getImageAttributes(editor);
        this.imageDisplay = attrs?.display || null;
      }

      private updateCellBackground(editor: Editor) {
        if (!this.tableActive) return;
        this.cellBackgroundColor =
          editor.getAttributes("tableCell").backgroundColor || "transparent";
      }

      private chain() {
        const editor = getEditor();
        if (!editorReady(editor)) return null;
        return editor.chain().focus() as any;
      }

      private isActive(
        nameOrAttrs: string | Record<string, unknown>,
        attrs?: Record<string, unknown>,
      ) {
        const editor = getEditor();
        return editorReady(editor)
          ? editor.isActive(nameOrAttrs as never, attrs as never)
          : false;
      }

      private canIndent() {
        const editor = getEditor();
        if (!editorReady(editor)) return false;
        return (
          editor.can().sinkListItem("listItem") || editor.can().sinkListItem("taskItem")
        );
      }

      private canOutdent() {
        const editor = getEditor();
        if (!editorReady(editor)) return false;
        return (
          editor.can().liftListItem("listItem") || editor.can().liftListItem("taskItem")
        );
      }

      private setHeading(level: number, event?: Event) {
        if (level === 0) {
          this.chain()?.setParagraph().run();
        } else {
          this.chain()?.toggleHeading({ level }).run();
        }
        event?.target?.dispatchEvent(
          new CustomEvent("exit", { bubbles: true, composed: true }),
        );
        this.update();
      }

      private setLink() {
        const editor = getEditor();
        if (!editorReady(editor)) return;

        const previousUrl = editor.getAttributes("link").href;
        const url = window.prompt("Enter URL:", previousUrl);
        if (url === null) return;
        if (url === "") {
          editor.chain().focus().extendMarkRange("link").unsetLink().run();
        } else {
          editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
        }
        this.update();
      }

      private indentListItem() {
        const editor = getEditor();
        if (!editorReady(editor)) return;
        if (editor.isActive("taskItem") && editor.can().sinkListItem("taskItem")) {
          editor.chain().focus().sinkListItem("taskItem").run();
        } else if (editor.can().sinkListItem("listItem")) {
          editor.chain().focus().sinkListItem("listItem").run();
        }
        this.update();
      }

      private outdentListItem() {
        const editor = getEditor();
        if (!editorReady(editor)) return;
        if (editor.isActive("taskItem") && editor.can().liftListItem("taskItem")) {
          editor.chain().focus().liftListItem("taskItem").run();
        } else if (editor.can().liftListItem("listItem")) {
          editor.chain().focus().liftListItem("listItem").run();
        }
        this.update();
      }

      private addInlineComment() {
        const editor = getEditor();
        if (!editorReady(editor)) return;

        const id = crypto.randomUUID().slice(0, 8);
        (editor.chain().focus() as any).setCommentAnchor(id).run();

        window.dispatchEvent(
          new CustomEvent("comment:create", {
            detail: { reference: `[data-comment-id="${id}"]` },
          }),
        );

        this.dismiss();
      }

      private setColumnCount(count: number) {
        const editor = getEditor();
        if (!editorReady(editor)) return;

        if (!editor.isActive("columnLayout")) {
          (editor.chain().focus() as any).setColumnLayout({ columns: count }).run();
          this.update();
          return;
        }

        const { state } = editor;
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type.name !== "columnLayout") continue;

          const pos = $from.before(d);
          const tr = state.tr;
          const currentColumns = node.content.childCount;

          if (count > currentColumns) {
            for (let i = currentColumns; i < count; i++) {
              const columnNode = editor.schema.nodes.columnItem.create(
                null,
                editor.schema.nodes.paragraph.create(),
              );
              tr.insert(pos + node.nodeSize - 1, columnNode);
            }
          } else if (count < currentColumns) {
            let offset = 0;
            for (let i = 0; i < currentColumns; i++) {
              const child = node.child(i);
              if (i >= count) {
                tr.delete(pos + 1 + offset, pos + 1 + offset + child.nodeSize);
              } else {
                offset += child.nodeSize;
              }
            }
          }

          tr.setNodeMarkup(pos, null, { columns: count });
          editor.view.dispatch(tr);
          this.update();
          return;
        }
      }

      private deleteColumnLayout() {
        const editor = getEditor();
        if (!editorReady(editor)) return;

        const { state } = editor;
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type.name !== "columnLayout") continue;

          const pos = $from.before(d);
          const tr = state.tr;
          tr.delete(pos, pos + node.nodeSize);
          editor.view.dispatch(tr);
          this.update();
          return;
        }
      }

      private cutRow() {
        const editor = getEditor();
        if (!editorReady(editor)) return;

        const { $from } = editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const node = $from.node(d);
          if (node.type.name === "tableRow") {
            this.copiedRow = node.toJSON();
            editor.chain().focus().deleteRow().run();
            this.update();
            return;
          }
        }
      }

      private pasteRow() {
        const editor = getEditor();
        if (!editorReady(editor) || !this.copiedRow) return;

        const { state, view } = editor;
        const { tr, selection, schema } = state;
        const { $from } = selection;
        for (let d = $from.depth; d > 0; d--) {
          if ($from.node(d).type.name === "tableRow") {
            tr.insert($from.after(d), schema.nodeFromJSON(this.copiedRow));
            view.dispatch(tr);
            this.update();
            return;
          }
        }
      }

      private onTextColor(event: Event) {
        const value = (event.target as HTMLInputElement).value;
        this.chain()?.setColor(value).run();
        this.update();
      }

      private onBgColor(event: Event) {
        const value = (event.target as HTMLInputElement).value;
        this.chain()?.setBackgroundColor(value).run();
        this.update();
      }

      private onCellBgColor(event: Event) {
        const value = (event.target as HTMLInputElement).value;
        this.chain()?.setCellAttribute("backgroundColor", value).run();
        this.update();
      }

      private button(
        label: unknown,
        title: string,
        onClick: () => void,
        options: { active?: boolean; disabled?: boolean; danger?: boolean } = {},
      ) {
        const classes = ["menu-btn"];
        if (options.active) classes.push("active");
        if (options.danger) classes.push("danger");
        return html`
          <button
            class=${classes.join(" ")}
            title=${title}
            type="button"
            ?disabled=${options.disabled}
            @mousedown=${(event: MouseEvent) => {
              event.preventDefault();
            }}
            @click=${() => {
              onClick();
              this.update();
            }}
          >
            ${label}
          </button>
        `;
      }

      private icon(svg: string) {
        return html`<span class="svg-icon icon" .innerHTML=${svg}></span>`;
      }

      private paint() {
        render(this.template(), this.root);
      }

      private template() {
        return html`
          <style>
            :host {
              --tb-bg: rgba(255, 255, 255, 0.94);
              --tb-border: #d1d5db;
              --tb-shadow: rgba(15, 23, 42, 0.14);
              --tb-text: #374151;
              --tb-hover-bg: #f3f4f6;
              --tb-active-bg: #dbeafe;
              --tb-active-border: #bfdbfe;
              --tb-active-text: #1d4ed8;
              --tb-divider: #e5e7eb;
              display: contents;
            }

            @media (prefers-color-scheme: dark) {
              :host {
                --tb-bg: rgba(24, 24, 27, 0.94);
                --tb-border: rgba(255, 255, 255, 0.12);
                --tb-shadow: rgba(0, 0, 0, 0.38);
                --tb-text: #d1d5db;
                --tb-hover-bg: rgba(255, 255, 255, 0.08);
                --tb-active-bg: rgba(37, 99, 235, 0.26);
                --tb-active-border: rgba(96, 165, 250, 0.48);
                --tb-active-text: #bfdbfe;
                --tb-divider: rgba(255, 255, 255, 0.12);
              }
            }

            .floating-menu,
            .table-toolbar {
              position: fixed;
              z-index: 50;
              display: flex;
              flex-direction: column;
              align-items: flex-start;
              gap: 0.25rem;
              color: var(--tb-text);
              font-family: inherit;
            }

            .table-toolbar {
              z-index: 40;
              flex-direction: row;
              align-items: center;
              gap: 2px;
              max-width: 95vw;
              overflow-x: auto;
              padding: 4px;
              border-radius: 10px;
              border: 1px solid var(--tb-border);
              background: var(--tb-bg);
              box-shadow: 0 6px 18px var(--tb-shadow);
              backdrop-filter: blur(8px);
              transform: translateY(calc(-100% - 0.5rem));
            }

            .toolbar-section,
            .menu-group {
              display: flex;
              align-items: center;
              gap: 2px;
            }

            .toolbar-section {
              max-width: 95vw;
              overflow-x: auto;
              padding: 2px;
              border-radius: 12px;
              border: 1px solid var(--tb-border);
              background: var(--tb-bg);
              box-shadow: 0 10px 28px var(--tb-shadow);
              backdrop-filter: blur(8px);
            }

            .menu-btn {
              position: relative;
              display: inline-flex;
              align-items: center;
              justify-content: center;
              min-width: 36px;
              height: 36px;
              border: 1px solid transparent;
              border-radius: 8px;
              padding: 0 6px;
              color: var(--tb-text);
              background: transparent;
              font: inherit;
              font-size: 0.875rem;
              font-weight: 600;
              cursor: pointer;
              transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
            }

            .menu-btn:hover:not(:disabled) {
              background: var(--tb-hover-bg);
            }

            .menu-btn.active {
              border-color: var(--tb-active-border);
              background: var(--tb-active-bg);
              color: var(--tb-active-text);
            }

            .menu-btn.danger {
              color: #b91c1c;
            }

            .menu-btn:disabled {
              cursor: default;
              opacity: 0.45;
            }

            .menu-divider {
              width: 1px;
              height: 24px;
              margin: 0 2px;
              background: var(--tb-divider);
            }

            .icon,
            .svg-icon {
              width: 1.25rem;
              height: 1.25rem;
              display: inline-flex;
              align-items: center;
            }

            .icon-overlay,
            .icon-overlay-danger {
              position: absolute;
              top: -0.125rem;
              right: -0.125rem;
              width: 0.75rem;
              height: 0.75rem;
            }

            .icon-overlay {
              color: var(--color-green-600, #16a34a);
            }

            .icon-overlay-danger {
              color: var(--color-red-600, #dc2626);
            }

            .color-picker-wrapper {
              position: relative;
              display: flex;
              align-items: center;
              gap: 2px;
            }

            .color-trigger {
              flex-direction: column;
              gap: 0.125rem;
              padding-top: 0.375rem;
              padding-bottom: 0.25rem;
            }

            .color-bar {
              width: 100%;
              height: 2px;
              border-radius: 999px;
              background: currentColor;
            }

            input[type="color"] {
              position: absolute;
              width: 0;
              height: 0;
              opacity: 0;
              pointer-events: none;
            }

            a-popover-trigger {
              display: inline-flex;
            }

            a-popover {
              display: block;
            }

            @media (max-width: 1023px) {
              .columns-section {
                display: none;
              }
            }
          </style>

          ${this.shouldShow ? this.renderFormattingToolbar() : null}
          ${this.tableActive ? this.renderTableToolbar() : null}
        `;
      }

      private renderFormattingToolbar() {
        const editor = getEditor();
        if (!editorReady(editor)) return null;

        return html`
          <div
            class="floating-menu"
            style=${this.floatingStyle}
            @mousedown=${() => {
              this.interacting = true;
            }}
            @mouseup=${() => {
              window.setTimeout(() => {
                this.interacting = false;
              }, 100);
            }}
          >
            <div class="toolbar-section">
              <div class="menu-group">
                <a-popover-trigger showdelay="0" hidedelay="100">
                  <button
                    slot="trigger"
                    class="menu-btn heading-trigger"
                    title="Heading Level"
                    type="button"
                    @mousedown=${(event: MouseEvent) => {
                      event.preventDefault();
                    }}
                  >
                    <span class="heading-label">${this.headingLevel === 0 ? "P" : `H${this.headingLevel}`}</span>
                    ${this.icon(chevronDownIcon)}
                  </button>
                  <a-popover placements="bottom-start">
                    ${this.renderHeadingDropdown()}
                  </a-popover>
                </a-popover-trigger>
              </div>
              <div class="menu-divider"></div>

              <div class="menu-group">
                ${this.button(
                  this.icon(boldIcon),
                  "Bold",
                  () => this.chain()?.toggleBold().run(),
                  {
                    active: this.isActive("bold"),
                  },
                )}
                ${this.button(
                  this.icon(italicIcon),
                  "Italic",
                  () => this.chain()?.toggleItalic().run(),
                  {
                    active: this.isActive("italic"),
                  },
                )}
                ${this.button(
                  this.icon(underlineIcon),
                  "Underline",
                  () => this.chain()?.toggleUnderline().run(),
                  {
                    active: this.isActive("underline"),
                  },
                )}
              </div>
              <div class="menu-divider"></div>

              <div class="menu-group">
                ${this.button(
                  this.icon(listUnorderedIcon),
                  "Bullet List",
                  () => this.chain()?.toggleBulletList().run(),
                  {
                    active: this.isActive("bulletList"),
                  },
                )}
                ${this.button(
                  this.icon(listOrderedIcon),
                  "Numbered List",
                  () => this.chain()?.toggleOrderedList().run(),
                  {
                    active: this.isActive("orderedList"),
                  },
                )}
                ${this.button(
                  this.icon(listCheckIcon),
                  "Task List",
                  () => this.chain()?.toggleTaskList().run(),
                  {
                    active: this.isActive("taskList"),
                  },
                )}
              </div>

              ${
                !this.imageActive &&
                !this.inColumnLayout &&
                this.hasAttribute("data-comments-enabled")
                  ? html`
                    <div class="menu-divider"></div>
                    <div class="menu-group">
                      ${this.button(this.icon(commentIcon), "Add comment", () =>
                        this.addInlineComment(),
                      )}
                    </div>
                  `
                  : null
              }

              <div class="menu-divider"></div>
              <div class="menu-group">
                ${this.button(
                  this.icon(moreIcon),
                  "More Formatting",
                  () => {
                    this.secondaryOpen = !this.secondaryOpen;
                  },
                  { active: this.secondaryOpen },
                )}
              </div>
            </div>

            ${
              this.secondaryOpen
                ? html`
                  <div class="toolbar-section toolbar-section--secondary">
                    ${
                      this.imageActive
                        ? html`
                          <div class="menu-group">
                            ${this.button(
                              this.icon(imageFullWidthIcon),
                              "Toggle Full Width",
                              () => {
                                toggleImageFullWidth(editor);
                              },
                              { active: this.imageDisplay === "full" },
                            )}
                            ${this.button(
                              this.icon(restoreArrowIcon),
                              "Reset Image Size",
                              () => {
                                resetImageSize(editor);
                              },
                            )}
                          </div>
                          <div class="menu-divider"></div>
                        `
                        : null
                    }

                    <div class="menu-group">
                      ${this.button(
                        this.icon(strikethroughIcon),
                        "Strikethrough",
                        () => this.chain()?.toggleStrike().run(),
                        {
                          active: this.isActive("strike"),
                        },
                      )}
                      ${this.button(this.icon(linkIcon), "Link", () => this.setLink(), {
                        active: this.isActive("link"),
                      })}
                    </div>
                    <div class="menu-divider"></div>

                    <div class="menu-group">
                      ${this.button(
                        this.icon(alignLeftIcon),
                        "Align Left",
                        () => this.chain()?.setTextAlign("left").run(),
                        {
                          active: this.isActive({ textAlign: "left" }),
                        },
                      )}
                      ${this.button(
                        this.icon(alignCenterIcon),
                        "Align Center",
                        () => this.chain()?.setTextAlign("center").run(),
                        {
                          active: this.isActive({ textAlign: "center" }),
                        },
                      )}
                      ${this.button(
                        this.icon(alignRightIcon),
                        "Align Right",
                        () => this.chain()?.setTextAlign("right").run(),
                        {
                          active: this.isActive({ textAlign: "right" }),
                        },
                      )}
                      ${this.button(
                        this.icon(alignJustifyIcon),
                        "Justify",
                        () => this.chain()?.setTextAlign("justify").run(),
                        {
                          active: this.isActive({ textAlign: "justify" }),
                        },
                      )}
                    </div>
                    <div class="menu-divider"></div>

                    <div class="menu-group">
                      ${this.button(
                        this.icon(indentIcon),
                        "Indent List Item",
                        () => this.indentListItem(),
                        {
                          disabled: !this.canIndent(),
                        },
                      )}
                      ${this.button(
                        this.icon(outdentIcon),
                        "Outdent List Item",
                        () => this.outdentListItem(),
                        {
                          disabled: !this.canOutdent(),
                        },
                      )}
                    </div>
                    <div class="menu-divider"></div>

                    <div class="menu-group">
                      <div class="color-picker-wrapper">
                        ${this.button(
                          html`${this.icon(textColorIcon)}
                            <span class="color-bar" style=${`background:${this.textColor}`}></span>`,
                          "Text Color",
                          () => this.textColorInput?.click(),
                          { active: this.textColor !== "#000000" },
                        )}
                        <input
                          data-text-color
                          type="color"
                          .value=${this.textColor}
                          @input=${(event: Event) => this.onTextColor(event)}
                        />
                      </div>
                      <div class="color-picker-wrapper">
                        ${this.button(
                          html`${this.icon(highlightIcon)}
                            <span class="color-bar" style=${`background:${this.bgColor}`}></span>`,
                          "Background Color",
                          () => this.bgColorInput?.click(),
                          { active: this.bgColor !== "transparent" },
                        )}
                        <input
                          data-bg-color
                          type="color"
                          .value=${this.bgColor === "transparent" ? "#ffff00" : this.bgColor}
                          @input=${(event: Event) => this.onBgColor(event)}
                        />
                        ${
                          this.bgColor !== "transparent"
                            ? this.button(
                                this.icon(closeThickIcon),
                                "Clear Background Color",
                                () => this.chain()?.unsetBackgroundColor().run(),
                              )
                            : null
                        }
                      </div>
                    </div>

                    ${
                      this.inColumnLayout
                        ? html`
                          <div class="menu-divider"></div>
                          <div class="menu-group columns-section">
                            ${[
                              [2, columns2Icon],
                              [3, columns3Icon],
                              [4, columns4Icon],
                            ].map(([count, icon]) =>
                              this.button(
                                this.icon(icon as string),
                                `${count} Columns`,
                                () => this.setColumnCount(count as number),
                                {
                                  active: this.columnCount === count,
                                },
                              ),
                            )}
                            ${this.button(
                              this.icon(closeThickIcon),
                              "Delete Column Layout",
                              () => this.deleteColumnLayout(),
                              { danger: true },
                            )}
                          </div>
                        `
                        : null
                    }
                  </div>
                `
                : null
            }
          </div>
        `;
      }

      private renderHeadingDropdown() {
        return html`
          <div class="document-heading-dropdown">
            ${[0, 2, 3, 4].map(
              (level) => html`
              <button
                class=${`document-heading-option${this.headingLevel === level ? " active" : ""}`}
                type="button"
                @mousedown=${(event: MouseEvent) => {
                  event.preventDefault();
                }}
                @click=${(event: Event) => this.setHeading(level, event)}
              >
                ${level === 0 ? "Paragraph" : `Heading ${level}`}
              </button>
            `,
            )}
          </div>
        `;
      }

      private renderTableToolbar() {
        return html`
          <div class="table-toolbar" style=${this.tableStyle}>
            <div class="menu-group">
              ${this.button(
                html`${this.icon(tableColumnAddBeforeIcon)}
                  <span class="svg-icon icon-overlay" .innerHTML=${plusOverlayIcon}></span>`,
                "Add Column Before",
                () => this.chain()?.addColumnBefore().run(),
              )}
              ${this.button(
                html`${this.icon(tableColumnAddAfterIcon)}
                  <span class="svg-icon icon-overlay" .innerHTML=${plusOverlayIcon}></span>`,
                "Add Column After",
                () => this.chain()?.addColumnAfter().run(),
              )}
              ${this.button(
                html`${this.icon(columnDeleteIcon)}
                  <span class="svg-icon icon-overlay-danger" .innerHTML=${closeThickIcon}></span>`,
                "Delete Column",
                () => this.chain()?.deleteColumn().run(),
                { danger: true },
              )}
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              ${this.button(
                html`${this.icon(tableRowIcon)}
                  <span class="svg-icon icon-overlay" .innerHTML=${plusOverlayIcon}></span>`,
                "Add Row Before",
                () => this.chain()?.addRowBefore().run(),
              )}
              ${this.button(
                html`${this.icon(tableRowAddAfterIcon)}
                  <span class="svg-icon icon-overlay" .innerHTML=${plusOverlayIcon}></span>`,
                "Add Row After",
                () => this.chain()?.addRowAfter().run(),
              )}
              ${this.button(
                html`${this.icon(rowDeleteIcon)}
                  <span class="svg-icon icon-overlay-danger" .innerHTML=${closeThickIcon}></span>`,
                "Delete Row",
                () => this.chain()?.deleteRow().run(),
                { danger: true },
              )}
              ${this.button(
                html`${this.icon(rowDeleteIcon)}
                  <span class="svg-icon icon-overlay" .innerHTML=${scissorsIcon}></span>`,
                "Cut Row",
                () => this.cutRow(),
              )}
              ${this.button(
                html`${this.icon(rowDeleteIcon)}
                  <span class="svg-icon icon-overlay" .innerHTML=${pasteIcon}></span>`,
                "Paste Row",
                () => this.pasteRow(),
                { disabled: !this.copiedRow },
              )}
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              ${this.button(
                this.icon(tableHeaderCellIcon),
                "Toggle Header Cell",
                () => this.chain()?.toggleHeaderCell().run(),
                { active: this.isActive("tableHeader") },
              )}
              ${this.button(this.icon(cellMergeIcon), "Merge Cells", () =>
                this.chain()?.mergeCells().run(),
              )}
              ${this.button(this.icon(tableSplitCellIcon), "Split Cell", () =>
                this.chain()?.splitCell().run(),
              )}
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              ${this.button(this.icon(expressionCellIcon), "Insert Expression Cell", () =>
                this.chain()?.insertExpressionCell({ formula: "=" }).run(),
              )}
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              <div class="color-picker-wrapper">
                ${this.button(
                  html`${this.icon(highlightIcon)}
                    <span class="color-bar" style=${`background:${this.cellBackgroundColor}`}></span>`,
                  "Cell Background Color",
                  () => this.cellBgColorInput?.click(),
                  { active: this.cellBackgroundColor !== "transparent" },
                )}
                <input
                  data-cell-bg-color
                  type="color"
                  .value=${
                    this.cellBackgroundColor === "transparent"
                      ? "#ffffff"
                      : this.cellBackgroundColor
                  }
                  @input=${(event: Event) => this.onCellBgColor(event)}
                />
                ${
                  this.cellBackgroundColor !== "transparent"
                    ? this.button(
                        this.icon(closeThickIcon),
                        "Clear Cell Background",
                        () =>
                          this.chain()?.setCellAttribute("backgroundColor", null).run(),
                      )
                    : null
                }
              </div>
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              ${this.button(
                this.icon(tableDeleteIcon),
                "Delete Table",
                () => this.chain()?.deleteTable().run(),
                { danger: true },
              )}
            </div>
          </div>
        `;
      }
    },
  );
}
