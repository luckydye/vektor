import type { Model } from "@ironcalc/wasm";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import {
  type Accessor,
  createComponent,
  createSignal,
  type Setter,
} from "solid-js";
import { render } from "solid-js/web";
import {
  isSpreadsheetTable,
  spreadsheetTableFingerprint,
  spreadsheetTableHtml,
  spreadsheetTableNodeFromData,
} from "#spreadsheet/documentTable.ts";
import {
  SPREADSHEET_SELECTION_EVENT,
  type SpreadsheetSelectionEventDetail,
  subscribeToSpreadsheetPresence,
} from "#spreadsheet/documentPresence.ts";
import type { RemoteSelection, SheetSelection } from "#spreadsheet/presence.ts";
import { browserLang, createTranslator } from "#utils/lang.ts";

type GetPos = () => number | undefined;
const SPREADSHEET_VIEWPORT_GAP = 32;
const t = createTranslator(browserLang());

/** Interactive editor-only view for a table marked as a spreadsheet. */
export class SpreadsheetTableView implements NodeView {
  readonly dom: HTMLDivElement;
  private readonly mount: HTMLDivElement;
  private node: ProseMirrorNode;
  private model: Model | null = null;
  private disposeRender: (() => void) | null = null;
  private destroyed = false;
  private buildVersion = 0;
  private publishVersion = 0;
  private publishedFingerprint: string | null = null;
  private lastSelection: SheetSelection | null = null;
  private readonly remoteSelections: Accessor<RemoteSelection[]>;
  private readonly setRemoteSelections: Setter<RemoteSelection[]>;
  private readonly unsubscribePresence: () => void;
  private layoutObserver: ResizeObserver | null = null;
  private layoutFrame: number | null = null;

  constructor(
    node: ProseMirrorNode,
    private readonly editor: Editor,
    private readonly getPos: GetPos,
  ) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "spreadsheet-table-wrapper";
    this.dom.contentEditable = "false";

    this.mount = document.createElement("div");
    this.mount.className = "spreadsheet-table-mount";
    this.mount.textContent = t("Loading spreadsheet…");
    this.dom.append(this.mount);

    [this.remoteSelections, this.setRemoteSelections] =
      createSignal<RemoteSelection[]>([]);
    this.unsubscribePresence = subscribeToSpreadsheetPresence(
      this.editor,
      this.getPos,
      this.setRemoteSelections,
    );
    this.dom.addEventListener("focusin", this.handleFocusIn);
    this.dom.addEventListener("focusout", this.handleFocusOut);
    window.addEventListener("resize", this.scheduleViewportHeight);
    window.visualViewport?.addEventListener("resize", this.scheduleViewportHeight);
    this.layoutObserver = new ResizeObserver(this.scheduleViewportHeight);
    const layout = document.querySelector<HTMLElement>("[data-layout]");
    if (layout) this.layoutObserver.observe(layout);
    this.scheduleViewportHeight();

    void this.rebuild();
  }

  /**
   * Fills the part of the initial viewport left below the document chrome.
   * The bottom margin is included so the table and its spacing, together, end
   * at the viewport edge instead of making the page one margin taller.
   */
  private syncViewportHeight(): void {
    this.layoutFrame = null;
    if (this.destroyed || !this.dom.isConnected) return;

    const viewport = window.visualViewport;
    const viewportBottom = viewport
      ? viewport.offsetTop + viewport.height
      : window.innerHeight;
    const top = this.dom.getBoundingClientRect().top;
    const marginBottom = Number.parseFloat(getComputedStyle(this.dom).marginBottom) || 0;
    const available = Math.max(
      0,
      Math.floor(
        viewportBottom - top - marginBottom - SPREADSHEET_VIEWPORT_GAP,
      ),
    );
    const height = `${available}px`;
    if (this.dom.style.getPropertyValue("--spreadsheet-viewport-height") !== height) {
      this.dom.style.setProperty("--spreadsheet-viewport-height", height);
    }
  }

  private scheduleViewportHeight = (): void => {
    if (this.layoutFrame !== null) return;
    this.layoutFrame = requestAnimationFrame(() => this.syncViewportHeight());
  };

  private hasFocus(): boolean {
    return this.dom.matches(":focus-within");
  }

  private dispatchSelection(selection: SheetSelection | null): void {
    this.dom.dispatchEvent(
      new CustomEvent<SpreadsheetSelectionEventDetail>(
        SPREADSHEET_SELECTION_EVENT,
        {
          bubbles: true,
          composed: true,
          detail: {
            source: this.dom,
            getTablePosition: this.getPos,
            selection,
          },
        },
      ),
    );
  }

  private handleSelectionChange = (selection: SheetSelection): void => {
    this.lastSelection = selection;
    if (this.hasFocus()) this.dispatchSelection(selection);
  };

  private handleFocusIn = (): void => {
    if (this.lastSelection) this.dispatchSelection(this.lastSelection);
  };

  private handleFocusOut = (): void => {
    queueMicrotask(() => {
      if (!this.destroyed && !this.hasFocus()) this.dispatchSelection(null);
    });
  };

  private clearModel(): void {
    this.disposeRender?.();
    this.disposeRender = null;
    this.model?.free();
    this.model = null;
    this.mount.replaceChildren();
  }

  private async rebuild(): Promise<void> {
    const version = ++this.buildVersion;
    this.clearModel();
    this.mount.textContent = t("Loading spreadsheet…");

    try {
      const [{ initEngine }, { createModel }, { SpreadsheetHost }] = await Promise.all([
        import("#spreadsheet/engine.ts"),
        import("#spreadsheet/spreadsheetModel.ts"),
        import("#spreadsheet/SpreadsheetHost.tsx"),
      ]);
      await initEngine();
      if (this.destroyed || version !== this.buildVersion) return;

      const model = createModel(spreadsheetTableHtml(this.node), "Table");
      if (this.lastSelection) {
        const { row, column, rowEnd, columnEnd } = this.lastSelection;
        // IronCalc requires its active cell to be one of the range's corners.
        // A freshly rebuilt model starts at A1, so restoring a range elsewhere
        // must move the active cell before restoring the range itself.
        model.setSelectedCell(row, column);
        model.setSelectedRange(row, column, rowEnd, columnEnd);
      }
      this.model = model;
      this.mount.replaceChildren();
      this.disposeRender = render(
        () =>
          createComponent(SpreadsheetHost, {
            lang: browserLang(),
            model,
            canEdit: this.editor.isEditable,
            remoteRevision: () => 0,
            remoteSelections: this.remoteSelections,
            onSelectionChange: this.handleSelectionChange,
            onChange: () => this.publish(),
            onUndo: () => this.editor.commands.undo(),
            onRedo: () => this.editor.commands.redo(),
          }),
        this.mount,
      );
    } catch (error) {
      if (this.destroyed || version !== this.buildVersion) return;
      this.mount.textContent = `${t("The spreadsheet could not be loaded.")} ${String(error)}`;
    }
  }

  private publish(): void {
    const model = this.model;
    if (!model) return;
    const version = ++this.publishVersion;

    void import("#spreadsheet/spreadsheetModel.ts").then(({ readSheet }) => {
      if (this.destroyed || this.model !== model || version !== this.publishVersion) {
        return;
      }
      const pos = this.getPos();
      if (pos === undefined) return;
      const current = this.editor.state.doc.nodeAt(pos);
      if (!current || !isSpreadsheetTable(current)) return;
      const next = spreadsheetTableNodeFromData(
        current,
        this.editor.schema,
        readSheet(model),
      );
      this.publishedFingerprint = spreadsheetTableFingerprint(next);
      this.node = next;
      this.editor.view.dispatch(
        this.editor.state.tr.replaceWith(pos, pos + current.nodeSize, next),
      );
    });
  }

  update(node: ProseMirrorNode): boolean {
    if (node.type !== this.node.type || !isSpreadsheetTable(node)) return false;
    const fingerprint = spreadsheetTableFingerprint(node);
    this.node = node;
    if (fingerprint === this.publishedFingerprint) {
      this.publishedFingerprint = null;
      return true;
    }
    void this.rebuild();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode(): void {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dispatchSelection(null);
    this.destroyed = true;
    this.buildVersion++;
    this.publishVersion++;
    this.unsubscribePresence();
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    if (this.layoutFrame !== null) cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = null;
    window.removeEventListener("resize", this.scheduleViewportHeight);
    window.visualViewport?.removeEventListener(
      "resize",
      this.scheduleViewportHeight,
    );
    this.dom.removeEventListener("focusin", this.handleFocusIn);
    this.dom.removeEventListener("focusout", this.handleFocusOut);
    this.clearModel();
  }
}
