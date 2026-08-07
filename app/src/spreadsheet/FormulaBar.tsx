import { columnNameFromNumber, type Model } from "@ironcalc/wasm";
import { createMemo } from "solid-js";
import { Icon } from "#components/Icon.tsx";
import { CellEditor } from "#spreadsheet/CellEditor.tsx";
import type { WorkbookState } from "#spreadsheet/grid/workbookState.ts";

interface Props {
  model: Model;
  workbookState: WorkbookState;
  canEdit: boolean;
  revision: () => number;
  refresh: () => void;
  onEditEnd: () => void;
  onError: (message: string) => void;
}

/**
 * The address of the selected cell, and an editor onto its contents. The editor
 * is the same component the grid puts in the cell — both write to the one
 * editing session, and `EditingCell.focus` decides which has the caret.
 */
export function FormulaBar(props: Props) {
  const view = createMemo(() => {
    props.revision();
    return props.model.getSelectedView();
  });

  const address = createMemo(() => {
    const { row, column, range } = view();
    const [rowStart, columnStart, rowEnd, columnEnd] = range;
    const single = rowStart === rowEnd && columnStart === columnEnd;
    if (single) return `${columnNameFromNumber(column)}${row}`;
    const rows = Math.abs(rowEnd - rowStart) + 1;
    const columns = Math.abs(columnEnd - columnStart) + 1;
    return `${rows}R × ${columns}C`;
  });

  const cellContent = createMemo(() => {
    const { sheet, row, column } = view();
    return props.model.getCellContent(sheet, row, column);
  });

  return (
    <div class="ic-formula-bar">
      <div class="ic-name-box">
        {address()}
        <Icon name="chevron-down" />
      </div>
      <span class="ic-fx">fx</span>
      <div class="ic-formula-bar-input">
        <CellEditor
          model={props.model}
          workbookState={props.workbookState}
          originalText={cellContent()}
          type="formula-bar"
          canEdit={props.canEdit}
          revision={props.revision}
          onEditEnd={props.onEditEnd}
          onTextUpdated={props.refresh}
          onError={props.onError}
        />
      </div>
    </div>
  );
}
