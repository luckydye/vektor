import type { Model } from "@ironcalc/wasm";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { NodeView } from "@tiptap/pm/view";
import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import {
  isSpreadsheetTable,
  normalTableNodeFromSpreadsheet,
  spreadsheetTableFingerprint,
  spreadsheetTableHtml,
  spreadsheetTableNodeFromData,
} from "#spreadsheet/documentTable.ts";
import { browserLang, createTranslator } from "#utils/lang.ts";

type GetPos = () => number | undefined;
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

  constructor(
    node: ProseMirrorNode,
    private readonly editor: Editor,
    private readonly getPos: GetPos,
  ) {
    this.node = node;
    this.dom = document.createElement("div");
    this.dom.className = "spreadsheet-table-wrapper";
    this.dom.contentEditable = "false";

    const header = document.createElement("div");
    header.className = "spreadsheet-table-header";
    const label = document.createElement("span");
    label.textContent = t("Spreadsheet");
    header.append(label);

    const convert = document.createElement("button");
    convert.type = "button";
    convert.textContent = t("Convert to table");
    convert.title = t("Formulas will be replaced by their displayed values");
    convert.addEventListener("click", this.convertToTable);
    header.append(convert);
    this.dom.append(header);

    this.mount = document.createElement("div");
    this.mount.className = "spreadsheet-table-mount";
    this.mount.textContent = t("Loading spreadsheet…");
    this.dom.append(this.mount);

    void this.rebuild();
  }

  private convertToTable = () => {
    const pos = this.getPos();
    if (pos === undefined) return;
    const current = this.editor.state.doc.nodeAt(pos);
    if (!current || !isSpreadsheetTable(current)) return;
    this.editor.view.dispatch(
      this.editor.state.tr.replaceWith(
        pos,
        pos + current.nodeSize,
        normalTableNodeFromSpreadsheet(current),
      ),
    );
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
      this.model = model;
      this.mount.replaceChildren();
      this.disposeRender = render(
        () =>
          createComponent(SpreadsheetHost, {
            model,
            canEdit: this.editor.isEditable,
            remoteRevision: () => 0,
            remoteSelections: () => [],
            onSelectionChange: () => {},
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
    this.destroyed = true;
    this.buildVersion++;
    this.publishVersion++;
    this.dom.querySelector("button")?.removeEventListener("click", this.convertToTable);
    this.clearModel();
  }
}
