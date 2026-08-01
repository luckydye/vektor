import { columnNameFromNumber, type Model } from "@ironcalc/wasm";
import { createMemo } from "solid-js";
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
    <div class="flex h-8 flex-none items-stretch border-neutral-100 border-b">
      <div class="flex w-24 flex-none items-center justify-center border-neutral-100 border-r text-neutral-600 text-size-small tabular-nums">
        {address()}
      </div>
      <div class="relative min-w-0 flex-1 px-4xs">
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
