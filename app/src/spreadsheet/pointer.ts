// Ported from IronCalc `components/Worksheet/usePointer.ts` at tag v0.8.3, MIT
// OR Apache-2.0. De-Reactified: the `useRef` flags are closure variables and
// the element refs are accessors. See ./grid/README.md.

import type { Model } from "@ironcalc/wasm";
import { isInReferenceMode } from "./formulaTokens.ts";
import { rangeToStr } from "./grid/address.ts";
import { LAST_COLUMN, LAST_ROW } from "./grid/constants.ts";
import type { Cell } from "./grid/types.ts";
import type { WorkbookState } from "./grid/workbookState.ts";
import type { WorksheetCanvas } from "./grid/worksheetCanvas.ts";
import { headerColumnWidth, headerRowHeight } from "./grid/worksheetCanvas.ts";

interface PointerSettings {
  canvasElement: () => HTMLCanvasElement | null;
  worksheetCanvas: () => WorksheetCanvas | null;
  worksheetElement: () => HTMLElement | null;
  onCellSelected: (cell: Cell, event: PointerEvent) => void;
  onRowSelected: (row: number, shift: boolean) => void;
  onColumnSelected: (column: number, shift: boolean) => void;
  onAllSheetSelected: () => void;
  onAreaSelecting: (cell: Cell) => void;
  onAreaSelected: () => void;
  model: Model;
  workbookState: WorkbookState;
  refresh: () => void;
}

interface PointerEvents {
  onPointerDown: (event: PointerEvent) => void;
  onPointerMove: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
}

export function createPointerHandlers(options: PointerSettings): PointerEvents {
  let isSelecting = false;
  let isInserting = false;
  let isSelectingRows = false;
  let initialRow: number | null = null;
  let isSelectingColumns = false;
  let initialColumn: number | null = null;

  const onPointerMove = (event: PointerEvent): void => {
    // Range selections are disabled on non-mouse devices. Use touch move only
    // to scroll for now.
    if (event.pointerType !== "mouse") {
      return;
    }

    if (!(isSelecting || isInserting || isSelectingRows || isSelectingColumns)) {
      return;
    }
    const { canvasElement, model, worksheetCanvas, refresh } = options;
    const canvas = canvasElement();
    const worksheet = worksheetCanvas();
    // Silence the linter
    if (!worksheet || !canvas) {
      return;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const x = event.clientX - canvasRect.x;
    const y = event.clientY - canvasRect.y;

    if (isSelectingRows) {
      // Prevent text selection during row dragging
      event.preventDefault();
      // Handle row selection dragging
      if (initialRow === null) {
        return;
      }
      let targetRow: number | null = null;
      if (x >= 0 && x < headerColumnWidth && y >= headerRowHeight) {
        const cell = worksheet.getCellByCoordinates(headerColumnWidth, y);
        if (cell) {
          targetRow = cell.row;
        }
      } else if (x >= headerColumnWidth && y >= headerRowHeight) {
        const cell = worksheet.getCellByCoordinates(x, y);
        if (cell) {
          targetRow = cell.row;
        }
      }

      if (targetRow !== null) {
        model.setSelectedCell(Math.min(initialRow, targetRow), 1);
        model.setSelectedRange(
          Math.min(initialRow, targetRow),
          1,
          Math.max(initialRow, targetRow),
          LAST_COLUMN,
        );
        refresh();
      }
      return;
    }

    if (isSelectingColumns) {
      // Prevent text selection during column dragging
      event.preventDefault();
      // Handle column selection dragging
      if (initialColumn === null) {
        return;
      }
      let targetColumn: number | null = null;
      if (x >= headerColumnWidth && y >= 0 && y < headerRowHeight) {
        const cell = worksheet.getCellByCoordinates(x, headerRowHeight);
        if (cell) {
          targetColumn = cell.column;
        }
      } else if (x >= headerColumnWidth && y >= headerRowHeight) {
        const cell = worksheet.getCellByCoordinates(x, y);
        if (cell) {
          targetColumn = cell.column;
        }
      }

      if (targetColumn !== null) {
        model.setSelectedCell(1, Math.min(initialColumn, targetColumn));
        model.setSelectedRange(
          1,
          Math.min(initialColumn, targetColumn),
          LAST_ROW,
          Math.max(initialColumn, targetColumn),
        );
        refresh();
      }
      return;
    }

    const cell = worksheet.getCellByCoordinates(x, y);
    if (!cell) {
      return;
    }

    if (isSelecting) {
      options.onAreaSelecting(cell);
    } else if (isInserting) {
      const { workbookState } = options;
      const editingCell = workbookState.getEditingCell();
      if (!editingCell?.referencedRange) {
        return;
      }
      const range = editingCell.referencedRange.range;
      range.rowEnd = cell.row;
      range.columnEnd = cell.column;

      const sheetNames = model.getWorksheetsProperties().map((s) => s.name);

      editingCell.referencedRange.str = rangeToStr(
        range,
        editingCell.sheet,
        sheetNames[range.sheet],
      );
      workbookState.setEditingCell(editingCell);
      refresh();
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (isSelecting) {
      const { worksheetElement } = options;
      isSelecting = false;
      worksheetElement()?.releasePointerCapture(event.pointerId);
      options.onAreaSelected();
    } else if (isInserting) {
      const { worksheetElement } = options;
      isInserting = false;
      worksheetElement()?.releasePointerCapture(event.pointerId);
    } else if (isSelectingRows) {
      const { worksheetElement } = options;
      isSelectingRows = false;
      initialRow = null;
      worksheetElement()?.releasePointerCapture(event.pointerId);
    } else if (isSelectingColumns) {
      const { worksheetElement } = options;
      isSelectingColumns = false;
      initialColumn = null;
      worksheetElement()?.releasePointerCapture(event.pointerId);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    const target = event.target as HTMLElement;
    if (target.className === "column-resize-handle") {
      // we are resizing a column
      return;
    }
    if (target.className.includes("ironcalc-cell-handle")) {
      // we are extending values
      return;
    }
    if (event.button === 2) {
      return;
    }
    let x = event.clientX;
    let y = event.clientY;
    const {
      canvasElement,
      model,
      refresh,
      worksheetElement,
      worksheetCanvas,
      workbookState,
      onRowSelected,
      onColumnSelected,
      onAllSheetSelected,
    } = options;
    const worksheet = worksheetCanvas();
    const canvas = canvasElement();
    const worksheetWrapper = worksheetElement();
    // Silence the linter
    if (!canvas || !worksheet || !worksheetWrapper) {
      return;
    }
    const canvasRect = canvas.getBoundingClientRect();
    x -= canvasRect.x;
    y -= canvasRect.y;
    // Makes sure is in the sheet area
    if (
      x > canvasRect.width ||
      x < headerColumnWidth ||
      y < headerRowHeight ||
      y > canvasRect.height
    ) {
      if (x < headerColumnWidth && y < headerRowHeight) {
        // Click on the top left corner
        onAllSheetSelected();
      } else if (
        x > 0 &&
        x < headerColumnWidth &&
        y > headerRowHeight &&
        y < canvasRect.height
      ) {
        // Click on a row number
        const cell = worksheet.getCellByCoordinates(headerColumnWidth, y);
        if (cell) {
          if (event.shiftKey) {
            // Shift+click: extend selection
            onRowSelected(cell.row, true);
          } else {
            // Regular click: start drag selection
            event.preventDefault();
            initialRow = cell.row;
            isSelectingRows = true;
            worksheetWrapper.setPointerCapture(event.pointerId);
            onRowSelected(cell.row, false);
          }
        }
      } else if (
        x > headerColumnWidth &&
        x < canvasRect.width &&
        y > 0 &&
        y < headerRowHeight
      ) {
        // Click on a column letter
        const cell = worksheet.getCellByCoordinates(x, headerRowHeight);
        if (cell) {
          if (event.shiftKey) {
            // Shift+click: extend selection
            onColumnSelected(cell.column, true);
          } else {
            // Regular click: start drag selection
            event.preventDefault();
            initialColumn = cell.column;
            isSelectingColumns = true;
            worksheetWrapper.setPointerCapture(event.pointerId);
            onColumnSelected(cell.column, false);
          }
        }
      }
      return;
    }

    const editingCell = workbookState.getEditingCell();
    const cell = worksheet.getCellByCoordinates(x, y);
    if (cell) {
      if (editingCell) {
        if (
          model.getSelectedSheet() === editingCell.sheet &&
          cell.row === editingCell.row &&
          cell.column === editingCell.column
        ) {
          // We are clicking on the cell we are editing
          // we do nothing
          return;
        }
        // now we are editing one cell and we click in another one
        // If we can insert a range we do that
        const text = editingCell.text;
        if (isInReferenceMode(model, text, editingCell.cursorEnd)) {
          const range = {
            sheet: model.getSelectedSheet(),
            rowStart: cell.row,
            rowEnd: cell.row,
            columnStart: cell.column,
            columnEnd: cell.column,
          };
          const sheetNames = model.getWorksheetsProperties().map((s) => s.name);
          editingCell.referencedRange = {
            range,
            str: rangeToStr(range, editingCell.sheet, sheetNames[range.sheet]),
            anchorRow: range.rowStart,
            anchorColumn: range.columnStart,
          };
          workbookState.setEditingCell(editingCell);
          event.stopPropagation();
          event.preventDefault();
          isInserting = true;
          worksheetWrapper.setPointerCapture(event.pointerId);
          refresh();
          return;
        }
        // We are clicking away but we are not in reference mode
        // We finish the editing
        model.setUserInput(
          editingCell.sheet,
          editingCell.row,
          editingCell.column,
          workbookState.getEditingText(),
        );
        workbookState.clearEditingCell();
        // we continue to select the new cell
      }
      if (event.shiftKey) {
        // We are extending the selection
        options.onAreaSelecting(cell);
        options.onAreaSelected();
      } else {
        // We are selecting a single cell
        options.onCellSelected(cell, event);
        isSelecting = true;
        worksheetWrapper.setPointerCapture(event.pointerId);
      }
    }
  };

  return { onPointerDown, onPointerMove, onPointerUp };
}
