// The grid surface, ported from IronCalc `components/Worksheet/Worksheet.tsx` at
// tag v0.8.3 (MIT OR Apache-2.0) and rewritten in Solid. See ./grid/README.md.
//
// This component owns no drawing. It lays out the elements `WorksheetCanvas`
// paints into — a canvas plus the overlay divs for the selection outlines, the
// resize guides and the column headers — hands them over, and re-renders the
// canvas whenever the revision counter moves.
//
// Scrolling is a scroll container with an oversized spacer inside it. The canvas
// stays put (`position: sticky`) and redraws from the new scroll offset, so the
// sheet can be a million rows tall without a million elements.

import type { Model } from "@ironcalc/wasm";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { CellEditor } from "#spreadsheet/CellEditor.tsx";
import { LAST_COLUMN, LAST_ROW } from "#spreadsheet/grid/constants.ts";
import type { Cell } from "#spreadsheet/grid/types.ts";
import type { WorkbookState } from "#spreadsheet/grid/workbookState.ts";
import {
  headerColumnWidth,
  headerRowHeight,
  type ScrollOffset,
  WorksheetCanvas,
} from "#spreadsheet/grid/worksheetCanvas.ts";
import { createPointerHandlers } from "#spreadsheet/pointer.ts";

export interface HeaderTarget {
  kind: "cell" | "column" | "row";
  x: number;
  y: number;
}

interface Props {
  model: Model;
  workbookState: WorkbookState;
  canEdit: boolean;
  revision: () => number;
  refresh: () => void;
  onCanvas: (canvas: WorksheetCanvas | null) => void;
  onContextMenu: (target: HeaderTarget) => void;
  onStartEditing: () => void;
  onError: (message: string) => void;
}

export function Worksheet(props: Props) {
  let scrollElement!: HTMLDivElement;
  let spacerElement!: HTMLDivElement;
  let sheetContainer!: HTMLDivElement;
  let canvasElement!: HTMLCanvasElement;
  let cellOutline!: HTMLDivElement;
  let cellArrayStructure!: HTMLDivElement;
  let areaOutline!: HTMLDivElement;
  let extendToOutline!: HTMLDivElement;
  let columnGuide!: HTMLDivElement;
  let rowGuide!: HTMLDivElement;
  let columnHeaders!: HTMLDivElement;
  let editorWrapper!: HTMLDivElement;

  const [canvas, setCanvas] = createSignal<WorksheetCanvas | null>(null);
  // The canvas is rebuilt on resize and on a theme change, but the sub-cell
  // scroll offset describes where the *view* is, so it outlives those.
  const scrollOffset: ScrollOffset = { x: 0, y: 0 };
  // Set while we move the scroll container ourselves, so the resulting scroll
  // event is not mistaken for the user scrolling.
  let ignoreScrollEvent = false;

  const buildCanvas = () => {
    const sheet = new WorksheetCanvas({
      width: sheetContainer.clientWidth,
      height: sheetContainer.clientHeight,
      model: props.model,
      workbookState: props.workbookState,
      scrollOffset,
      elements: {
        canvas: canvasElement,
        columnGuide,
        rowGuide,
        columnHeaders,
        cellOutline,
        cellArrayStructure,
        areaOutline,
        extendToOutline,
        editor: editorWrapper,
      },
      onColumnWidthChanges(sheetIndex, column, width) {
        if (width < 0) return;
        // Dragging one edge of a full-column selection resizes all of them.
        const { range } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
        let columnStart = column;
        let columnEnd = column;
        const fullColumn = range[0] === 1 && range[2] === LAST_ROW;
        const fullRow = range[1] === 1 && range[3] === LAST_COLUMN;
        if (fullColumn && column >= range[1] && column <= range[3] && !fullRow) {
          columnStart = Math.min(range[1], column, range[3]);
          columnEnd = Math.max(range[1], column, range[3]);
        }
        props.model.setColumnsWidth(sheetIndex, columnStart, columnEnd, width);
        sheet.renderSheet();
      },
      onRowHeightChanges(sheetIndex, row, height) {
        if (height < 0) return;
        const { range } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
        let rowStart = row;
        let rowEnd = row;
        const fullColumn = range[0] === 1 && range[2] === LAST_ROW;
        const fullRow = range[1] === 1 && range[3] === LAST_COLUMN;
        if (fullRow && row >= range[0] && row <= range[2] && !fullColumn) {
          rowStart = Math.min(range[0], row, range[2]);
          rowEnd = Math.max(range[0], row, range[2]);
        }
        props.model.setRowsHeight(sheetIndex, rowStart, rowEnd, height);
        sheet.renderSheet();
      },
      refresh: () => props.refresh(),
    });
    setCanvas(sheet);
    props.onCanvas(sheet);
    return sheet;
  };

  onMount(() => {
    const sheet = buildCanvas();

    // The spacer only has to be longer than anywhere the user has scrolled to,
    // so it grows with the view rather than spanning the whole address space —
    // a million rows of real pixels overflow what browsers will scroll.
    const sizeSpacer = () => {
      spacerElement.style.width = `${props.model.getScrollX() + 100_000}px`;
      spacerElement.style.height = `${props.model.getScrollY() + 500_000}px`;
    };
    sizeSpacer();
    sheet.renderSheet();

    // Keep the canvas the size of its container, and rebuild it when the app's
    // theme changes: the palette is read from CSS when the canvas is built.
    const resizeObserver = new ResizeObserver(() => {
      const current = canvas();
      if (!current) return;
      current.setSize({
        width: sheetContainer.clientWidth,
        height: sheetContainer.clientHeight,
      });
      props.model.setWindowWidth(sheetContainer.clientWidth - headerColumnWidth);
      props.model.setWindowHeight(sheetContainer.clientHeight - headerRowHeight);
      current.renderSheet();
    });
    resizeObserver.observe(sheetContainer);

    const rebuildForTheme = () => buildCanvas().renderSheet();
    const themeObserver = new MutationObserver(rebuildForTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const colorScheme = window.matchMedia("(prefers-color-scheme: dark)");
    colorScheme.addEventListener("change", rebuildForTheme);

    onCleanup(() => {
      resizeObserver.disconnect();
      themeObserver.disconnect();
      colorScheme.removeEventListener("change", rebuildForTheme);
      props.onCanvas(null);
    });
  });

  // Repaint whenever anything changed the model, and follow the model's scroll
  // position if it moved on its own (keyboard navigation off-screen).
  createEffect(() => {
    props.revision();
    const sheet = canvas();
    if (!sheet) return;
    spacerElement.style.width = `${props.model.getScrollX() + 100_000}px`;
    spacerElement.style.height = `${props.model.getScrollY() + 500_000}px`;

    const targetLeft = props.model.getScrollX() + scrollOffset.x;
    const targetTop = props.model.getScrollY() + scrollOffset.y;
    // Anything below a pixel is left alone: assigning scrollLeft/scrollTop in
    // the middle of a momentum scroll would fight the browser.
    if (Math.abs(targetLeft - scrollElement.scrollLeft) >= 1) {
      ignoreScrollEvent = true;
      scrollElement.scrollLeft = targetLeft;
      setTimeout(() => {
        ignoreScrollEvent = false;
      }, 0);
    }
    if (Math.abs(targetTop - scrollElement.scrollTop) >= 1) {
      ignoreScrollEvent = true;
      scrollElement.scrollTop = targetTop;
      setTimeout(() => {
        ignoreScrollEvent = false;
      }, 0);
    }
    sheet.renderSheet();
  });

  const pointer = createPointerHandlers({
    model: props.model,
    workbookState: props.workbookState,
    refresh: () => props.refresh(),
    canvasElement: () => canvasElement,
    worksheetElement: () => sheetContainer,
    worksheetCanvas: () => canvas(),
    onColumnSelected: (column, shift) => {
      let firstColumn = column;
      let lastColumn = column;
      if (shift) {
        const { range } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
        firstColumn = Math.min(range[1], column, range[3]);
        lastColumn = Math.max(range[3], column, range[1]);
      }
      props.model.setSelectedCell(1, firstColumn);
      props.model.setSelectedRange(1, firstColumn, LAST_ROW, lastColumn);
      props.refresh();
    },
    onRowSelected: (row, shift) => {
      let firstRow = row;
      let lastRow = row;
      if (shift) {
        const { range } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
        firstRow = Math.min(range[0], row, range[2]);
        lastRow = Math.max(range[2], row, range[0]);
      }
      props.model.setSelectedCell(firstRow, 1);
      props.model.setSelectedRange(firstRow, 1, lastRow, LAST_COLUMN);
      props.refresh();
    },
    onAllSheetSelected: () => {
      props.model.setSelectedCell(1, 1);
      props.model.setSelectedRange(1, 1, LAST_ROW, LAST_COLUMN);
      props.refresh();
    },
    onCellSelected: (cell: Cell, event) => {
      event.preventDefault();
      event.stopPropagation();
      props.model.setSelectedCell(cell.row, cell.column);
      props.refresh();
    },
    onAreaSelecting: (cell: Cell) => {
      const sheet = canvas();
      if (!sheet) return;
      props.workbookState.setSelecting(true);
      props.model.onAreaSelecting(cell.row, cell.column);
      sheet.renderSheet();
      props.refresh();
    },
    onAreaSelected: () => {
      props.workbookState.setSelecting(false);
      sheetContainer.style.cursor = "auto";
      props.refresh();
    },
  });

  const onScroll = () => {
    const sheet = canvas();
    if (!sheet || ignoreScrollEvent) return;
    sheet.setScrollPosition({
      left: scrollElement.scrollLeft,
      top: scrollElement.scrollTop,
    });
    sheet.renderSheet();
  };

  /** Which band of the grid a point falls in: the headers, or the cells. */
  const targetAt = (clientX: number, clientY: number): HeaderTarget => {
    const rect = canvasElement.getBoundingClientRect();
    const x = clientX - rect.x;
    const y = clientY - rect.y;
    const sheet = canvas();
    if (y > 0 && y < headerRowHeight && x > headerColumnWidth) {
      // Right-clicking outside the current selection selects what was clicked,
      // so the menu always acts on what the user is pointing at.
      const column = sheet?.getCellByCoordinates(x, headerRowHeight)?.column;
      if (column !== undefined) {
        const { range } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
        const columnsSelected = range[0] === 1 && range[2] === LAST_ROW;
        if (!columnsSelected || column < range[1] || column > range[3]) {
          props.model.setSelectedCell(1, column);
          props.model.setSelectedRange(1, column, LAST_ROW, column);
          props.refresh();
        }
      }
      return { kind: "column", x: clientX, y: clientY };
    }
    if (x > 0 && x < headerColumnWidth && y > headerRowHeight) {
      const row = sheet?.getCellByCoordinates(headerColumnWidth, y)?.row;
      if (row !== undefined) {
        const { range } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
        const rowsSelected = range[1] === 1 && range[3] === LAST_COLUMN;
        if (!rowsSelected || row < range[0] || row > range[2]) {
          props.model.setSelectedCell(row, 1);
          props.model.setSelectedRange(row, 1, row, LAST_COLUMN);
          props.refresh();
        }
      }
      return { kind: "row", x: clientX, y: clientY };
    }
    const cell = sheet?.getCellByCoordinates(x, y);
    if (cell) {
      const [rowStart, columnStart, rowEnd, columnEnd] =
        props.model.getSelectedView().range;
      const inside =
        rowStart <= cell.row &&
        cell.row <= rowEnd &&
        columnStart <= cell.column &&
        cell.column <= columnEnd;
      if (!inside) {
        props.model.setSelectedCell(cell.row, cell.column);
        props.refresh();
      }
    }
    return { kind: "cell", x: clientX, y: clientY };
  };

  return (
    <div class="ic-worksheet-wrapper" ref={scrollElement} onScroll={onScroll}>
      <div class="ic-worksheet-spacer" ref={spacerElement} />
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the grid surface is
          driven from the focusable root in Spreadsheet.tsx, which owns the
          keyboard; this element only routes pointer input to the canvas. */}
      <div
        class="ic-worksheet-sheet-container"
        ref={sheetContainer}
        onPointerDown={pointer.onPointerDown}
        onPointerMove={pointer.onPointerMove}
        onPointerUp={pointer.onPointerUp}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          // The menu only offers editing actions, so it stays away in read-only.
          if (!props.canEdit) return;
          props.onContextMenu(targetAt(event.clientX, event.clientY));
        }}
        onDblClick={(event) => {
          if (!props.canEdit) return;
          event.stopPropagation();
          props.onStartEditing();
        }}
      >
        <canvas class="ic-worksheet-sheet-canvas" ref={canvasElement} />
        <div class="ic-worksheet-cell-array-structure" ref={cellArrayStructure} />
        <div class="ic-worksheet-cell-outline" ref={cellOutline} />
        <div class="ic-worksheet-editor-wrapper" ref={editorWrapper}>
          <CellEditor
            model={props.model}
            workbookState={props.workbookState}
            originalText=""
            type="cell"
            canEdit={props.canEdit}
            revision={props.revision}
            onEditEnd={props.refresh}
            onTextUpdated={props.refresh}
            onError={props.onError}
          />
        </div>
        <div class="ic-worksheet-area-outline" ref={areaOutline} />
        <div class="ic-worksheet-extend-to-outline" ref={extendToOutline} />
        <div class="ic-worksheet-column-resize-guide" ref={columnGuide} />
        <div class="ic-worksheet-row-resize-guide" ref={rowGuide} />
        <div class="ic-worksheet-column-headers" ref={columnHeaders} />
      </div>
    </div>
  );
}
