// The spreadsheet, assembled: formula bar, grid, right-click menu.
//
// Rewritten in Solid from IronCalc `components/Workbook/Workbook.tsx` at tag
// v0.8.3 (MIT OR Apache-2.0). See ./grid/README.md.
//
// Neither the `Model` (a wasm handle) nor the `WorkbookState` is reactive, and
// almost every action is a call into the engine. So there is one signal — a
// revision counter — that `refresh()` bumps after any such call, and everything
// reading either of them subscribes to it. That is the whole reactivity story.
//
// No sheet tabs: an embedded spreadsheet table holds a single sheet. The formatting
// toolbar is in Toolbar.tsx, and everything it offers is persisted in table markup.

import type { Model } from "@ironcalc/wasm";
import { createEffect, createSignal, on, Show } from "solid-js";
import { Icon } from "#components/Icon.tsx";
import { useTranslation } from "#composeables/useTranslation.ts";
import { FormulaBar } from "#spreadsheet/FormulaBar.tsx";
import { GridContextMenu, type GridMenuAction } from "#spreadsheet/GridContextMenu.tsx";
import {
  COLUMN_WIDTH_SCALE,
  LAST_COLUMN,
  LAST_ROW,
  ROW_HEIGH_SCALE,
} from "#spreadsheet/grid/constants.ts";
import { WorkbookState } from "#spreadsheet/grid/workbookState.ts";
import { createNavigationKeyHandler } from "#spreadsheet/navigationKeys.ts";
import {
  type RemoteSelection,
  type SheetSelection,
  sameSelection,
} from "#spreadsheet/presence.ts";
import { Toolbar } from "#spreadsheet/Toolbar.tsx";
import { type HeaderTarget, Worksheet } from "#spreadsheet/Worksheet.tsx";
import "#spreadsheet/spreadsheet.css";

interface Props {
  model: Model;
  canEdit: boolean;
  /** Called after anything that changed the workbook's contents. */
  onChange: () => void;
  /** Bumped when a peer's edit has been applied to the model; repaint. */
  remoteRevision: () => number;
  /** Where everyone else in the room has their selection. */
  remoteSelections: () => RemoteSelection[];
  /** This client's selection moved; tell the room. */
  onSelectionChange: (selection: SheetSelection) => void;
  /** Overrides the engine-local history when embedded in another editor. */
  onUndo?: () => void;
  onRedo?: () => void;
  /**
   * The shadow root this is rendered into. `document.activeElement` reports the
   * host, not what is focused inside, so anything asking "do we have focus?"
   * has to ask the root itself.
   */
  shadowRoot: ShadowRoot;
}

/** The shape IronCalc's own copy/paste puts on the clipboard. */
const INTERNAL_MIME = "application/json";

export function Spreadsheet(props: Props) {
  const t = useTranslation();
  let root!: HTMLDivElement;
  const workbookState = new WorkbookState();
  const [revision, setRevision] = createSignal(0);
  const [menuAt, setMenuAt] = createSignal<{ x: number; y: number } | null>(null);
  const [menuKind, setMenuKind] = createSignal<HeaderTarget["kind"]>("cell");
  const [error, setError] = createSignal<string | null>(null);

  /** Repaint. Call after anything that touched the model or workbook state. */
  const refresh = () => setRevision((value) => value + 1);

  // A peer's edit is already in the model by the time this fires; all that is
  // left is to redraw. It must not mark the document dirty — the change came
  // from the room, and republishing it would be an echo.
  createEffect(on(props.remoteRevision, refresh, { defer: true }));

  // Selection is model state, so it changes on the same signal as everything
  // else; only an actual move is worth a message to the room.
  let published: SheetSelection | null = null;
  createEffect(() => {
    revision();
    const [rowStart, columnStart, rowEnd, columnEnd] =
      props.model.getSelectedView().range;
    const selection: SheetSelection = {
      row: Math.min(rowStart, rowEnd),
      column: Math.min(columnStart, columnEnd),
      rowEnd: Math.max(rowStart, rowEnd),
      columnEnd: Math.max(columnStart, columnEnd),
    };
    if (sameSelection(published, selection)) return;
    published = selection;
    props.onSelectionChange(selection);
  });

  /** Repaint, and tell the owner the document now differs from what was saved. */
  const mutated = () => {
    refresh();
    props.onChange();
  };

  /** Runs an engine call that can reject (a full sheet, a bad formula). */
  const attempt = (action: () => void) => {
    try {
      action();
      mutated();
    } catch (thrown) {
      setError(String(thrown));
    }
  };

  /**
   * Puts the keyboard on the grid.
   *
   * The collapsed selection inside the root is not cosmetic: a `copy` or `cut`
   * event only fires for a document selection, and everything the grid shows is
   * painted on a canvas, so there is never a natural one.
   */
  const focusRoot = () => {
    root.focus({ preventScroll: true });
    const selection = window.getSelection();
    const anchor = root.firstChild;
    if (!selection || !anchor) return;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(anchor, 0);
    range.setEnd(anchor, 0);
    selection.addRange(range);
  };

  /**
   * An edit finished. Focus was on the editor's textarea, which is now gone, so
   * the keyboard has to be handed back to the grid — otherwise typing after
   * pressing Enter goes nowhere. Only when the focus was still ours: ending the
   * edit by clicking elsewhere in the app must not drag it back.
   */
  const endEditing = () => {
    const hadFocus = root.contains(props.shadowRoot.activeElement);
    mutated();
    if (hadFocus && !workbookState.getEditingCell()) focusRoot();
  };

  const startEditing = (
    initialText?: string,
    focus: "cell" | "formula-bar" = "cell",
  ) => {
    const { sheet, row, column } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
    // Typing into a cell replaces it and stays in "accept" mode, where an arrow
    // key commits and moves on. F2 or a double-click opens the existing text in
    // "edit" mode, where the arrows move the caret instead.
    const text = initialText ?? props.model.getCellContent(sheet, row, column);
    workbookState.setEditingCell({
      sheet,
      row,
      column,
      text,
      cursorStart: text.length,
      cursorEnd: text.length,
      focus,
      referencedRange: null,
      activeRanges: [],
      mode: initialText === undefined ? "edit" : "accept",
      editorWidth: props.model.getColumnWidth(sheet, column) * COLUMN_WIDTH_SCALE,
      editorHeight: props.model.getRowHeight(sheet, row) * ROW_HEIGH_SCALE,
    });
    refresh();
  };

  const onKeyDown = createNavigationKeyHandler({
    root: () => root,
    canEdit: () => props.canEdit,
    onArrowDown: () => {
      props.model.onArrowDown();
      refresh();
    },
    onArrowUp: () => {
      props.model.onArrowUp();
      refresh();
    },
    onArrowLeft: () => {
      props.model.onArrowLeft();
      refresh();
    },
    onArrowRight: () => {
      props.model.onArrowRight();
      refresh();
    },
    onPageDown: () => {
      props.model.onPageDown();
      refresh();
    },
    onPageUp: () => {
      props.model.onPageUp();
      refresh();
    },
    onNavigationToEdge: (direction) => {
      props.model.onNavigateToEdgeInDirection(direction);
      refresh();
    },
    onExpandAreaSelectedKeyboard: (key) => {
      props.model.onExpandSelectedRange(key);
      refresh();
    },
    onKeyHome: () => {
      const view = props.model.getSelectedView();
      props.model.setSelectedCell(view.row, 1);
      props.model.setTopLeftVisibleCell(view.top_row, 1);
      refresh();
    },
    onKeyEnd: () => {
      const view = props.model.getSelectedView();
      props.model.setSelectedCell(view.row, LAST_COLUMN);
      props.model.setTopLeftVisibleCell(view.top_row, LAST_COLUMN - 5);
      refresh();
    },
    onSelectColumn: () => {
      const { column } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
      props.model.setSelectedRange(1, column, LAST_ROW, column);
      refresh();
    },
    onSelectRow: () => {
      const { row } = props.model.getSelectedView(); // solid-reactivity-ok: destructures the engine's return value, not props
      props.model.setSelectedRange(row, 1, row, LAST_COLUMN);
      refresh();
    },
    onCellsDeleted: () => {
      const {
        sheet,
        range: [rowStart, columnStart, rowEnd, columnEnd],
      } = props.model.getSelectedView();
      attempt(() =>
        props.model.rangeClearContents(
          sheet,
          Math.min(rowStart, rowEnd),
          Math.min(columnStart, columnEnd),
          Math.max(rowStart, rowEnd),
          Math.max(columnStart, columnEnd),
        ),
      );
    },
    onEditKeyPressStart: (initialText) => startEditing(initialText),
    onCellEditStart: () => startEditing(),
    onUndo: () => {
      if (props.onUndo) {
        props.onUndo();
        return;
      }
      props.model.undo();
      mutated();
    },
    onRedo: () => {
      if (props.onRedo) {
        props.onRedo();
        return;
      }
      props.model.redo();
      mutated();
    },
    onEscape: () => {
      workbookState.clearCutRange();
      workbookState.setCopyStyles(null);
      refresh();
    },
  });

  /**
   * Copy and cut put two things on the clipboard: tab-separated text for other
   * applications, and the engine's own representation, which carries formulas
   * and formatting when the paste lands back in a spreadsheet.
   */
  const writeClipboard = (event: ClipboardEvent, type: "copy" | "cut") => {
    const data = props.model.copyToClipboard();
    const sheetData: Record<number, Record<number, unknown>> = {};
    data.data.forEach((columns, row) => {
      const rowData: Record<number, unknown> = {};
      columns.forEach((cell, column) => {
        rowData[column] = cell;
      });
      sheetData[row] = rowData;
    });
    event.clipboardData?.setData("text/plain", data.csv.trim());
    event.clipboardData?.setData(
      INTERNAL_MIME,
      JSON.stringify({
        type,
        area: data.range,
        sheetData,
        sheet: props.model.getSelectedSheet(),
      }),
    );
    event.preventDefault();
  };

  const onCopy = (event: ClipboardEvent) => {
    if (workbookState.getEditingCell()) return;
    writeClipboard(event, "copy");
  };

  const onCut = (event: ClipboardEvent) => {
    if (workbookState.getEditingCell()) return;
    if (!props.canEdit) {
      event.preventDefault();
      return;
    }
    writeClipboard(event, "cut");
    const [rowStart, columnStart, rowEnd, columnEnd] =
      props.model.getSelectedView().range;
    workbookState.setCutRange({
      sheet: props.model.getSelectedSheet(),
      rowStart,
      rowEnd,
      columnStart,
      columnEnd,
    });
    refresh();
  };

  const onPaste = (event: ClipboardEvent) => {
    if (workbookState.getEditingCell()) return;
    event.preventDefault();
    if (!props.canEdit) return;
    workbookState.clearCutRange();

    const internal = event.clipboardData?.getData(INTERNAL_MIME);
    if (internal) {
      const source = JSON.parse(internal);
      const data = new Map<number, Map<number, unknown>>();
      for (const [row, columns] of Object.entries(source.sheetData)) {
        const rowMap = new Map<number, unknown>();
        for (const [column, cell] of Object.entries(columns as object)) {
          rowMap.set(Number.parseInt(column, 10), cell);
        }
        data.set(Number.parseInt(row, 10), rowMap);
      }
      attempt(() =>
        props.model.pasteFromClipboard(
          source.sheet,
          source.area,
          // The engine's clipboard type is not exported by the bindings.
          data as never,
          source.type === "cut",
        ),
      );
      return;
    }

    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    const {
      sheet,
      range: [rowStart, columnStart, rowEnd, columnEnd],
    } = props.model.getSelectedView();
    attempt(() =>
      props.model.pasteCsvText(
        {
          sheet,
          row: Math.min(rowStart, rowEnd),
          column: Math.min(columnStart, columnEnd),
          width: Math.abs(columnEnd - columnStart) + 1,
          height: Math.abs(rowEnd - rowStart) + 1,
        },
        text,
      ),
    );
  };

  const menuActions = (): GridMenuAction[] => {
    const view = () => props.model.getSelectedView();
    const rowActions: GridMenuAction[] = [
      {
        label: t("Insert row above"),
        run: () => attempt(() => props.model.insertRows(view().sheet, view().row, 1)),
      },
      {
        label: t("Insert row below"),
        run: () =>
          attempt(() => props.model.insertRows(view().sheet, view().range[2] + 1, 1)),
      },
      {
        label: t("Delete row"),
        run: () => {
          const { sheet, range } = view();
          const count = Math.abs(range[2] - range[0]) + 1;
          attempt(() =>
            props.model.deleteRows(sheet, Math.min(range[0], range[2]), count),
          );
        },
      },
    ];
    const columnActions: GridMenuAction[] = [
      {
        label: t("Insert column left"),
        run: () =>
          attempt(() => props.model.insertColumns(view().sheet, view().column, 1)),
      },
      {
        label: t("Insert column right"),
        run: () =>
          attempt(() => props.model.insertColumns(view().sheet, view().range[3] + 1, 1)),
      },
      {
        label: t("Delete column"),
        run: () => {
          const { sheet, range } = view();
          const count = Math.abs(range[3] - range[1]) + 1;
          attempt(() =>
            props.model.deleteColumns(sheet, Math.min(range[1], range[3]), count),
          );
        },
      },
    ];
    const clipboardActions: GridMenuAction[] = [
      { label: t("Cut"), run: () => document.execCommand("cut") },
      { label: t("Copy"), run: () => document.execCommand("copy") },
    ];

    if (menuKind() === "row") return rowActions;
    if (menuKind() === "column") return columnActions;
    return [
      ...clipboardActions,
      { ...(rowActions[0] as GridMenuAction), separated: true },
      ...rowActions.slice(1),
      { ...(columnActions[0] as GridMenuAction), separated: true },
      ...columnActions.slice(1),
    ];
  };

  return (
    <div
      class="ic-root"
      classList={{ "ic-root--readonly": !props.canEdit }}
      ref={root}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the grid is a composite widget; focus lives on the root and every key is routed from here.
      tabIndex={0}
      // `application`, not `grid`: the cells are painted on a canvas, so there
      // are no row/gridcell elements behind a grid role and announcing one
      // would promise a structure assistive technology cannot then walk. This
      // says instead that the widget handles its own keys, which it does.
      role="application"
      aria-label={t("Spreadsheet")}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onCut={onCut}
      onPaste={onPaste}
      onClick={(event) => {
        // Clicking the grid must put focus back on the root, or the keyboard
        // handler above never sees anything. This has to be `click`, not
        // `pointerdown`: the browser's own focus handling runs on the mousedown
        // that follows, and would move focus straight back off again. While a
        // cell is being edited the editor owns focus, so leave it alone.
        if (workbookState.getEditingCell()) event.stopPropagation();
        else focusRoot();
      }}
    >
      <Toolbar
        model={props.model}
        canEdit={props.canEdit}
        revision={revision}
        apply={attempt}
        focusGrid={focusRoot}
      />

      <FormulaBar
        model={props.model}
        workbookState={workbookState}
        canEdit={props.canEdit}
        revision={revision}
        refresh={refresh}
        onEditStart={() => startEditing(undefined, "formula-bar")}
        onEditEnd={endEditing}
        onError={setError}
      />

      <Worksheet
        model={props.model}
        workbookState={workbookState}
        canEdit={props.canEdit}
        revision={revision}
        refresh={refresh}
        mutated={mutated}
        remoteSelections={props.remoteSelections}
        onEditEnd={endEditing}
        onStartEditing={() => startEditing()}
        onContextMenu={(target) => {
          setMenuKind(target.kind);
          setMenuAt({ x: target.x, y: target.y });
        }}
        onError={setError}
      />

      <GridContextMenu
        at={menuAt()}
        actions={menuActions()}
        onClose={() => {
          setMenuAt(null);
          focusRoot();
        }}
      />

      <Show when={error()}>
        <button
          class="ic-error"
          type="button"
          title={t("Dismiss")}
          onClick={() => setError(null)}
        >
          {error()}
        </button>
      </Show>
    </div>
  );
}
