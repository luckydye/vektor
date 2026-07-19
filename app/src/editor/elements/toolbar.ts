import type { ChainedCommands, Editor } from "@tiptap/core";
import "@atrium-ui/elements/color-picker";
import "@atrium-ui/elements/popover";
import { html, render } from "lit-html";
import {
  addColumnLeftIcon,
  addColumnRightIcon,
  addRowBottomIcon,
  addRowTopIcon,
  boldIcon,
  cancelIcon,
  cellFillIcon,
  chevronDownIcon,
  commentIcon,
  contextMenuMoreIcon,
  cutIcon,
  deleteColumnIcon,
  deleteElementIcon,
  deleteRowIcon,
  fourColumnsIcon,
  functionIcon,
  imageFullWidthIcon,
  indentIcon,
  italicIcon,
  justifyBlockIcon,
  justifyCenterIcon,
  justifyLeftIcon,
  justifyRightIcon,
  linkIcon,
  listIcon,
  mergeCellsIcon,
  numberedListIcon,
  outdentIcon,
  pasteIcon,
  restoreArrowIcon,
  splitCellsIcon,
  strikeThroughIcon,
  tableIcon,
  taskListIcon,
  textColorIcon,
  threeColumnsIcon,
  twoColumnsIcon,
  underlineIcon,
} from "#assets/icons.ts";

const TEXT_COLOR_PRESETS = [
  { label: "Charcoal", value: "#111827" },
  { label: "Gray", value: "#4b5563" },
  { label: "Red", value: "#b91c1c" },
  { label: "Orange", value: "#c2410c" },
  { label: "Amber", value: "#a16207" },
  { label: "Green", value: "#15803d" },
  { label: "Sky", value: "#0369a1" },
  { label: "Blue", value: "#1d4ed8" },
  { label: "Violet", value: "#6d28d9" },
  { label: "Pink", value: "#be185d" },
] as const;

const BACKGROUND_COLOR_PRESETS = [
  { label: "Gray", value: "#f3f4f6" },
  { label: "Red", value: "#fee2e2" },
  { label: "Orange", value: "#ffedd5" },
  { label: "Amber", value: "#fef3c7" },
  { label: "Yellow", value: "#fef9c3" },
  { label: "Green", value: "#dcfce7" },
  { label: "Cyan", value: "#cffafe" },
  { label: "Blue", value: "#dbeafe" },
  { label: "Violet", value: "#ede9fe" },
  { label: "Pink", value: "#fce7f3" },
] as const;

type ColorPreset = { label: string; value: string };

function getSelectedImageNode(editor: Editor) {
  const { state } = editor;
  const { selection } = state;
  const { $from } = selection;

  const node =
    $from.parent.type.name === "image" ? $from.parent : state.doc.nodeAt(selection.from);

  return node?.type.name === "image" ? node : null;
}

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

function resetImageSize(editor: Editor) {
  return editor.commands.updateAttributes("image", {
    width: null,
    display: null,
  });
}

export function isImageSelected(editor: Editor): boolean {
  return getSelectedImageNode(editor) !== null;
}

export function getImageAttributes(editor: Editor) {
  return getSelectedImageNode(editor)?.attrs ?? null;
}

type ToolbarChain = ChainedCommands & {
  setCommentAnchor: (id: string) => ToolbarChain;
  setColumnLayout: (attrs: { columns: number }) => ToolbarChain;
};

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
      private textColorActive = false;
      private bgColor = "transparent";
      private bgColorActive = false;
      private tableActive = false;
      private tableSelectionPointerDown = false;
      private editorSelectionPointerDown = false;
      private cellBackgroundColor = "transparent";
      private cellBackgroundActive = false;
      private copiedRow: unknown = null;
      private floatingStyle = "";
      private tableStyle = "";
      private dismissedSelectionKey: string | null = null;
      private _editor?: Editor;

      constructor() {
        super();
        this.root = this.attachShadow({ mode: "open" });
      }

      // `variant="canvas"` renders a reduced, markdown-only toolbar (the marks
      // canvas text shapes actually round-trip); the default drives the full
      // document editor. `standalone` binds directly to the assigned editor's
      // events instead of the document editor's global window events, so the
      // element can be reused for a canvas text node.
      // NOTE: these read the attributes rather than being named `variant` /
      // `standalone`. A getter named after the attribute would make
      // `"variant" in el` true, so Vue's DOM runtime sets it as a (setter-less)
      // property instead of an attribute — silently dropping it.
      private get isCanvasVariant(): boolean {
        return this.getAttribute("variant") === "canvas";
      }

      private get isStandalone(): boolean {
        return this.hasAttribute("standalone");
      }

      get editor(): Editor | undefined {
        return this._editor;
      }

      set editor(value: Editor | undefined) {
        if (this._editor === value) return;
        if (this.isStandalone) this.unbindEditorEvents();
        this._editor = value;
        if (this.isStandalone) {
          this.bindEditorEvents();
          this.update();
        }
      }

      // Public hook so a host that moves the editor without firing scroll/resize
      // (e.g. the canvas panning/zooming via a CSS transform) can keep the
      // fixed-position toolbar glued to the selection.
      reposition() {
        this.updatePosition();
      }

      connectedCallback() {
        if (!this.isStandalone) {
          window.addEventListener("editor-destroyed", this.handleEditModeEnd);
          window.addEventListener("editor-update", this.update);
          window.addEventListener(
            "table-selection-pointer-state",
            this.handleTableSelectionPointerState as EventListener,
          );
        }
        window.addEventListener("resize", this.updatePosition, { passive: true });
        document.addEventListener("pointerdown", this.handlePointerDown, true);
        document.addEventListener("pointerup", this.handlePointerUp);
        document.addEventListener("pointercancel", this.handlePointerUp);
        document.addEventListener("scroll", this.updatePosition, {
          passive: true,
          capture: true,
        });

        if (this.isStandalone) this.bindEditorEvents();

        this.update();
        this.paint();
      }

      disconnectedCallback() {
        if (!this.isStandalone) {
          window.removeEventListener("editor-destroyed", this.handleEditModeEnd);
          window.removeEventListener("editor-update", this.update);
          window.removeEventListener(
            "table-selection-pointer-state",
            this.handleTableSelectionPointerState as EventListener,
          );
        } else {
          this.unbindEditorEvents();
        }
        window.removeEventListener("resize", this.updatePosition);
        document.removeEventListener("pointerdown", this.handlePointerDown, true);
        document.removeEventListener("pointerup", this.handlePointerUp);
        document.removeEventListener("pointercancel", this.handlePointerUp);
        document.removeEventListener("scroll", this.updatePosition);
        this.editorSelectionPointerDown = false;
      }

      private bindEditorEvents() {
        const editor = this._editor;
        if (!editorReady(editor)) return;
        editor.on("transaction", this.update);
        editor.on("focus", this.update);
        editor.on("blur", this.handleEditorBlur);
        editor.on("destroy", this.handleEditorDestroy);
      }

      private unbindEditorEvents() {
        const editor = this._editor;
        if (!editor) return;
        editor.off("transaction", this.update);
        editor.off("focus", this.update);
        editor.off("blur", this.handleEditorBlur);
        editor.off("destroy", this.handleEditorDestroy);
      }

      private handleEditorBlur = () => {
        // Defer so a pointerdown landing on a toolbar button (which keeps the
        // editor focused via preventDefault) can cancel the hide.
        window.setTimeout(() => {
          const editor = this._editor;
          if (!editorReady(editor) || !editor.isFocused) {
            this.shouldShow = false;
            this.paint();
          }
        }, 150);
      };

      private handleEditorDestroy = () => {
        this.unbindEditorEvents();
        this._editor = undefined;
        this.shouldShow = false;
        this.editorSelectionPointerDown = false;
        this.paint();
      };

      private get menu() {
        return this.root.querySelector<HTMLElement>(".floating-menu");
      }

      private get tableMenu() {
        return this.root.querySelector<HTMLElement>(".table-toolbar");
      }

      private getEditor() {
        return this.editor;
      }

      private handleEditModeEnd = () => {
        this.shouldShow = false;
        this.tableActive = false;
        this.tableSelectionPointerDown = false;
        this.editorSelectionPointerDown = false;
        this.secondaryOpen = false;
        this.interacting = false;
        this.imageActive = false;
        this.dismissedSelectionKey = null;
        this.paint();
      };

      private handleTableSelectionPointerState = (
        event: CustomEvent<{ active: boolean }>,
      ) => {
        this.tableSelectionPointerDown = event.detail.active;
        this.paint();
      };

      dismiss() {
        const editor = this.getEditor();
        if (editorReady(editor)) {
          this.dismissedSelectionKey = this.toolbarSelectionKey(editor);
        }
        this.shouldShow = false;
        this.tableActive = false;
        this.tableSelectionPointerDown = false;
        this.editorSelectionPointerDown = false;
        this.secondaryOpen = false;
        this.interacting = false;
        this.paint();
      }

      private handlePointerDown = (event: PointerEvent) => {
        if (event.button !== 0) return;

        const editor = this.getEditor();
        if (!editorReady(editor) || !event.composedPath().includes(editor.view.dom)) {
          return;
        }

        this.editorSelectionPointerDown = true;
        this.paint();
      };

      openTextColorPicker() {
        this.root.querySelector<HTMLElement>("[data-color-trigger='text']")?.click();
      }

      openBackgroundColorPicker() {
        this.root.querySelector<HTMLElement>("[data-color-trigger='bg']")?.click();
      }

      private handlePointerUp = (event: PointerEvent) => {
        if (this.editorSelectionPointerDown) {
          this.editorSelectionPointerDown = false;
          this.paint();
        }

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
        const editor = this.getEditor();
        if (!editorReady(editor)) {
          this.shouldShow = false;
          this.secondaryOpen = false;
          this.tableActive = false;
          this.paint();
          return;
        }

        if (this.isCanvasVariant) {
          this.inColumnLayout = false;
          this.imageActive = false;
          this.tableActive = false;
          this.updateHeadingLevel(editor);
          // Show over a non-empty selection, but only while this node is
          // actually being edited. Unlike the single document editor, blurring
          // a canvas text node doesn't collapse its selection, so without the
          // focus check the bubble would linger after clicking away.
          const { from, to } = editor.state.selection;
          const selectedText = editor.state.doc.textBetween(from, to, " ");
          this.shouldShow =
            editor.isFocused && from !== to && selectedText.trim().length > 0;
          this.updatePosition();
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
        const editor = this.getEditor();
        if (!editorReady(editor)) return;

        if (this.tableActive) {
          this.tableStyle = this.getTableStyle(editor);
        } else {
          this.tableStyle = "";
        }

        if (this.shouldShow) {
          const menuWidth = this.menu?.offsetWidth ?? 600;
          const menuHeight = Math.max(this.menu?.offsetHeight ?? 48, 48);
          const left = this.leftAlignedToolbarPosition(editor, menuWidth);
          const top = this.computeFloatingTop(editor, menuHeight);
          this.floatingStyle = `left:${left}px;top:${top}px;`;
        }

        this.paint();
      };

      private computeFloatingTop(editor: Editor, menuHeight: number): number {
        const padding = 8;
        const gap = 10;
        const { from, to } = editor.state.selection;
        const start = editor.view.coordsAtPos(from);
        const end = editor.view.coordsAtPos(to);
        const selectionTop = Math.min(start.top, end.top);
        const selectionBottom = Math.max(start.bottom, end.bottom);
        const maxTop = window.innerHeight - menuHeight - padding;

        // Build list of rects the floating toolbar must not enter.
        // Selection itself is a forbidden zone.
        const forbidden: Array<{ top: number; bottom: number }> = [
          { top: selectionTop, bottom: selectionBottom },
        ];

        // Table toolbar occupies a rect we can read from the previous paint.
        if (this.tableActive) {
          const tableTop = this.getTableTop(editor);
          if (tableTop !== null) {
            const tableHeight = Math.max(
              this.tableMenu?.getBoundingClientRect().height ?? 0,
              48,
            );
            forbidden.push({ top: tableTop, bottom: tableTop + tableHeight });
          }
        }

        const overlaps = (t: number) =>
          forbidden.some((f) => t < f.bottom + gap && t + menuHeight > f.top - gap);

        // Prefer above selection
        const aboveTop = selectionTop - menuHeight - gap;
        if (aboveTop >= padding && !overlaps(aboveTop)) return aboveTop;

        // Try below selection
        const belowTop = selectionBottom + gap;
        if (belowTop <= maxTop && !overlaps(belowTop)) return belowTop;

        // Try below each forbidden zone (e.g. table toolbar)
        for (const f of forbidden) {
          const candidate = f.bottom + gap;
          if (candidate <= maxTop && !overlaps(candidate)) return candidate;
        }

        // Fallback: clamp to screen, preferring below over overlapping
        return Math.max(padding, Math.min(belowTop, maxTop));
      }

      private getTableTop(editor: Editor): number | null {
        const { state, view } = editor;
        const $from = state.doc.resolve(state.selection.from);
        for (let depth = $from.depth; depth > 0; depth--) {
          if ($from.node(depth).type.name === "table") {
            return view.coordsAtPos($from.before(depth)).top;
          }
        }
        return null;
      }

      private getTableStyle(editor: Editor) {
        const top = this.getTableTop(editor);
        if (top === null) return "";
        const left = this.leftAlignedToolbarPosition(
          editor,
          this.tableMenu?.offsetWidth ?? 400,
        );
        return `left:${left}px;top:${top}px;`;
      }

      private leftAlignedToolbarPosition(editor: Editor, toolbarWidth: number) {
        const padding = 8;
        const editorLeft = editor.view.dom.getBoundingClientRect().left;
        const maxLeft = window.innerWidth - toolbarWidth - padding;
        return Math.min(Math.max(editorLeft, padding), Math.max(padding, maxLeft));
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
        this.textColorActive = attrs.color != null;
        this.bgColorActive = attrs.backgroundColor != null;
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
        const backgroundColor = editor.getAttributes("tableCell").backgroundColor;
        this.cellBackgroundActive = backgroundColor != null;
        this.cellBackgroundColor = backgroundColor || "transparent";
      }

      private chain() {
        const editor = this.getEditor();
        if (!editorReady(editor)) return null;
        return editor.chain().focus() as ToolbarChain;
      }

      private isActive(
        nameOrAttrs: string | Record<string, unknown>,
        attrs?: Record<string, unknown>,
      ) {
        const editor = this.getEditor();
        return editorReady(editor)
          ? editor.isActive(nameOrAttrs as never, attrs as never)
          : false;
      }

      private canIndent() {
        const editor = this.getEditor();
        if (!editorReady(editor)) return false;
        return (
          editor.can().sinkListItem("listItem") || editor.can().sinkListItem("taskItem")
        );
      }

      private canOutdent() {
        const editor = this.getEditor();
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
        const editor = this.getEditor();
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
        const editor = this.getEditor();
        if (!editorReady(editor)) return;
        if (editor.isActive("taskItem") && editor.can().sinkListItem("taskItem")) {
          editor.chain().focus().sinkListItem("taskItem").run();
        } else if (editor.can().sinkListItem("listItem")) {
          editor.chain().focus().sinkListItem("listItem").run();
        }
        this.update();
      }

      private outdentListItem() {
        const editor = this.getEditor();
        if (!editorReady(editor)) return;
        if (editor.isActive("taskItem") && editor.can().liftListItem("taskItem")) {
          editor.chain().focus().liftListItem("taskItem").run();
        } else if (editor.can().liftListItem("listItem")) {
          editor.chain().focus().liftListItem("listItem").run();
        }
        this.update();
      }

      private toggleSecondaryToolbar() {
        this.secondaryOpen = !this.secondaryOpen;
        this.paint();
      }

      private addInlineComment() {
        const editor = this.getEditor();
        if (!editorReady(editor)) return;

        const id = crypto.randomUUID().slice(0, 8);
        (editor.chain().focus() as ToolbarChain).setCommentAnchor(id).run();

        window.dispatchEvent(
          new CustomEvent("comment:create", {
            detail: { reference: `[data-comment-id="${id}"]` },
          }),
        );

        this.dismiss();
      }

      private setColumnCount(count: number) {
        const editor = this.getEditor();
        if (!editorReady(editor)) return;

        if (!editor.isActive("columnLayout")) {
          (editor.chain().focus() as ToolbarChain)
            .setColumnLayout({ columns: count })
            .run();
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
        const editor = this.getEditor();
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
        const editor = this.getEditor();
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
        const editor = this.getEditor();
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

      private colorControl(options: {
        icon: string;
        label: string;
        value: string;
        active: boolean;
        onClear: () => void;
        palette: readonly ColorPreset[];
        onChange: (value: string) => void;
        triggerAttr?: string;
      }) {
        const clearTitle = `Clear ${options.label}`;
        const paletteStr = options.palette.map((p) => p.value).join(",");

        return html`
          <div class=${`color-control${options.active ? " active" : ""}`}>
            <a-popover-trigger showdelay="0" hidedelay="100">
              <span slot="trigger" class="color-trigger">
                <button
                  class="color-main"
                  title=${options.label}
                  type="button"
                  data-color-trigger=${options.triggerAttr ?? ""}
                  @mousedown=${(event: MouseEvent) => {
                    event.preventDefault();
                  }}
                >
                  ${this.icon(options.icon)}
                  <span class="color-swatch" style=${`background:${options.value}`}></span>
                </button>
              </span>
              <a-popover class="group" placements="bottom-start">
                <div class="w-max py-2 opacity-0 transition-opacity duration-100 group-[&[enabled]]:opacity-100">
                  <div class="bg-background border border-neutral-100 rounded-lg p-2 origin-top-left scale-95 transition-all shadow-large duration-150 group-[&[enabled]]:scale-100">
                    <a-color-picker
                      style="width:220px"
                      .value=${options.value}
                      palette=${paletteStr}
                      @change=${(event: Event) => {
                        const picker = event.target as HTMLElement & { value: string };
                        options.onChange(picker.value);
                        this.update();
                      }}
                    ></a-color-picker>
                  </div>
                </div>
              </a-popover>
            </a-popover-trigger>
            <button
              class="color-clear"
              title=${clearTitle}
              type="button"
              ?disabled=${!options.active}
              @mousedown=${(event: MouseEvent) => {
                event.preventDefault();
              }}
              @click=${() => {
                options.onClear();
                this.update();
              }}
            >
              ${this.icon(cancelIcon)}
            </button>
          </div>
        `;
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
              opacity: 1;
              pointer-events: auto;
              display: flex;
              flex-direction: column;
              align-items: flex-start;
              gap: 0.25rem;
              color: var(--tb-text);
              font-family: inherit;
              transition: opacity 0.12s ease;
            }

            .toolbar-hidden {
              opacity: 0;
              pointer-events: none;
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

            .color-picker-wrapper,
            .color-control {
              position: relative;
              display: flex;
              align-items: center;
            }

            .color-control {
              height: 36px;
              border: 1px solid transparent;
              border-radius: 8px;
              overflow: hidden;
              transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
            }

            .color-control:hover {
              background: var(--tb-hover-bg);
            }

            .color-control.active {
              border-color: var(--tb-active-border);
              background: var(--tb-active-bg);
              color: var(--tb-active-text);
            }

            .color-main,
            .color-clear {
              display: inline-flex;
              align-items: center;
              justify-content: center;
              height: 100%;
              border: 0;
              color: inherit;
              background: transparent;
              font: inherit;
              cursor: pointer;
            }

            .color-main {
              position: relative;
              width: 38px;
              padding: 0;
            }

            .color-main .svg-icon {
              width: 1.45rem;
              height: 1.45rem;
            }

            .color-trigger {
              display: inline-flex;
              height: 100%;
            }

            .color-swatch {
              position: absolute;
              right: 7px;
              bottom: 0px;
              left: 7px;
              height: 3px;
              border-radius: 999px;
              box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.14);
            }

            .color-clear {
              width: 22px;
              border-left: 1px solid var(--tb-divider);
              opacity: 0.8;
            }

            .color-clear:hover:not(:disabled) {
              background: rgba(0, 0, 0, 0.06);
            }

            .color-clear:disabled {
              cursor: default;
              opacity: 0.24;
            }

            .color-clear .svg-icon {
              width: 1rem;
              height: 1rem;
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

      private renderCanvasToolbar() {
        return html`
          <div
            class=${`floating-menu${this.editorSelectionPointerDown ? " toolbar-hidden" : ""}`}
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
                  { active: this.isActive("bold") },
                )}
                ${this.button(
                  this.icon(italicIcon),
                  "Italic",
                  () => this.chain()?.toggleItalic().run(),
                  { active: this.isActive("italic") },
                )}
                ${this.button(this.icon(linkIcon), "Link", () => this.setLink(), {
                  active: this.isActive("link"),
                })}
              </div>
              <div class="menu-divider"></div>
              <div class="menu-group">
                ${this.button(
                  this.icon(listIcon),
                  "Bullet List",
                  () => this.chain()?.toggleBulletList().run(),
                  { active: this.isActive("bulletList") },
                )}
                ${this.button(
                  this.icon(numberedListIcon),
                  "Numbered List",
                  () => this.chain()?.toggleOrderedList().run(),
                  { active: this.isActive("orderedList") },
                )}
              </div>
            </div>
          </div>
        `;
      }

      private renderFormattingToolbar() {
        const editor = this.getEditor();
        if (!editorReady(editor)) return null;

        if (this.isCanvasVariant) return this.renderCanvasToolbar();

        return html`
          <div
            class=${`floating-menu${this.tableSelectionPointerDown || this.editorSelectionPointerDown ? " toolbar-hidden" : ""}`}
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
                ${this.button(this.icon(linkIcon), "Link", () => this.setLink(), {
                  active: this.isActive("link"),
                })}
              </div>
              <div class="menu-divider"></div>

              <div class="menu-group">
                ${this.button(
                  this.icon(listIcon),
                  "Bullet List",
                  () => this.chain()?.toggleBulletList().run(),
                  {
                    active: this.isActive("bulletList"),
                  },
                )}
                ${this.button(
                  this.icon(numberedListIcon),
                  "Numbered List",
                  () => this.chain()?.toggleOrderedList().run(),
                  {
                    active: this.isActive("orderedList"),
                  },
                )}
                ${this.button(
                  this.icon(taskListIcon),
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
                  this.icon(contextMenuMoreIcon),
                  "More Formatting",
                  () => this.toggleSecondaryToolbar(),
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
                        this.icon(strikeThroughIcon),
                        "Strikethrough",
                        () => this.chain()?.toggleStrike().run(),
                        {
                          active: this.isActive("strike"),
                        },
                      )}
                    </div>
                    <div class="menu-divider"></div>

                    <div class="menu-group">
                      ${this.button(
                        this.icon(justifyLeftIcon),
                        "Align Left",
                        () => this.chain()?.setTextAlign("left").run(),
                        {
                          active: this.isActive({ textAlign: "left" }),
                        },
                      )}
                      ${this.button(
                        this.icon(justifyCenterIcon),
                        "Align Center",
                        () => this.chain()?.setTextAlign("center").run(),
                        {
                          active: this.isActive({ textAlign: "center" }),
                        },
                      )}
                      ${this.button(
                        this.icon(justifyRightIcon),
                        "Align Right",
                        () => this.chain()?.setTextAlign("right").run(),
                        {
                          active: this.isActive({ textAlign: "right" }),
                        },
                      )}
                      ${this.button(
                        this.icon(justifyBlockIcon),
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
                        ${this.colorControl({
                          icon: textColorIcon,
                          label: "Text Color",
                          value: this.textColor,
                          active: this.textColorActive,
                          onClear: () => this.chain()?.unsetColor().run(),
                          palette: TEXT_COLOR_PRESETS,
                          onChange: (value) => this.chain()?.setColor(value).run(),
                          triggerAttr: "text",
                        })}
                      </div>
                      <div class="color-picker-wrapper">
                        ${this.colorControl({
                          icon: cellFillIcon,
                          label: "Background Color",
                          value:
                            this.bgColor === "transparent" ? "#ffff00" : this.bgColor,
                          active: this.bgColorActive,
                          onClear: () => this.chain()?.unsetBackgroundColor().run(),
                          palette: BACKGROUND_COLOR_PRESETS,
                          onChange: (value) =>
                            this.chain()?.setBackgroundColor(value).run(),
                          triggerAttr: "bg",
                        })}
                      </div>
                    </div>

                    ${
                      this.inColumnLayout
                        ? html`
                          <div class="menu-divider"></div>
                          <div class="menu-group columns-section">
                            ${[
                              [2, twoColumnsIcon],
                              [3, threeColumnsIcon],
                              [4, fourColumnsIcon],
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
                              this.icon(deleteElementIcon),
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
          <div
            class=${`table-toolbar${this.tableSelectionPointerDown ? " toolbar-hidden" : ""}`}
            style=${this.tableStyle}
          >
            <div class="menu-group">
              ${this.button(this.icon(addColumnLeftIcon), "Add Column Before", () =>
                this.chain()?.addColumnBefore().run(),
              )}
              ${this.button(this.icon(addColumnRightIcon), "Add Column After", () =>
                this.chain()?.addColumnAfter().run(),
              )}
              ${this.button(
                this.icon(deleteColumnIcon),
                "Delete Column",
                () => this.chain()?.deleteColumn().run(),
                { danger: true },
              )}
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              ${this.button(this.icon(addRowTopIcon), "Add Row Before", () =>
                this.chain()?.addRowBefore().run(),
              )}
              ${this.button(this.icon(addRowBottomIcon), "Add Row After", () =>
                this.chain()?.addRowAfter().run(),
              )}
              ${this.button(
                this.icon(deleteRowIcon),
                "Delete Row",
                () => this.chain()?.deleteRow().run(),
                { danger: true },
              )}
              ${this.button(this.icon(cutIcon), "Cut Row", () => this.cutRow())}
              ${this.button(this.icon(pasteIcon), "Paste Row", () => this.pasteRow(), {
                disabled: !this.copiedRow,
              })}
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              ${this.button(
                this.icon(tableIcon),
                "Toggle Header Cell",
                () => this.chain()?.toggleHeaderCell().run(),
                { active: this.isActive("tableHeader") },
              )}
              ${this.button(this.icon(mergeCellsIcon), "Merge Cells", () =>
                this.chain()?.mergeCells().run(),
              )}
              ${this.button(this.icon(splitCellsIcon), "Split Cell", () =>
                this.chain()?.splitCell().run(),
              )}
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              ${this.button(this.icon(functionIcon), "Insert Expression Cell", () =>
                this.chain()?.insertExpressionCell({ formula: "=" }).run(),
              )}
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              <div class="color-picker-wrapper">
                ${this.colorControl({
                  icon: cellFillIcon,
                  label: "Cell Background",
                  value:
                    this.cellBackgroundColor === "transparent"
                      ? "#ffffff"
                      : this.cellBackgroundColor,
                  active: this.cellBackgroundActive,
                  onClear: () =>
                    this.chain()?.setCellAttribute("backgroundColor", null).run(),
                  palette: BACKGROUND_COLOR_PRESETS,
                  onChange: (value) =>
                    this.chain()?.setCellAttribute("backgroundColor", value).run(),
                })}
              </div>
            </div>
            <div class="menu-divider"></div>

            <div class="menu-group">
              ${this.button(
                this.icon(deleteElementIcon),
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
