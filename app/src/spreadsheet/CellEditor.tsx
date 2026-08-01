// The cell editor, ported from IronCalc `components/Editor/Editor.tsx` at tag
// v0.8.3 (MIT OR Apache-2.0) and rewritten in Solid. See ./grid/README.md.
//
// The trick, which is upstream's: a transparent textarea sits on top of a div
// holding the same text as coloured spans. The textarea owns the caret, the
// selection and every keystroke; the div is what you actually see. That is how
// the parts of a formula naming a cell can be tinted while editing stays a plain
// native text field.
//
// Two of these exist at once — one inside the grid, one in the formula bar — and
// `EditingCell.focus` says which of them holds the caret.

import type { Model } from "@ironcalc/wasm";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { createEditorKeyHandler } from "#spreadsheet/editorKeys.ts";
import { getFormulaSegments } from "#spreadsheet/formulaTokens.ts";
import type { WorkbookState } from "#spreadsheet/grid/workbookState.ts";

interface Props {
  model: Model;
  workbookState: WorkbookState;
  /** The text to show when this editor is not the one being typed into. */
  originalText: string;
  /** Which editor this is; compared against the editing cell's `focus`. */
  type: "cell" | "formula-bar";
  canEdit: boolean;
  /**
   * Bumped whenever the model or the workbook state changed. Neither is
   * reactive — they are a wasm handle and a plain class — so this counter is
   * what everything reading them subscribes to.
   */
  revision: () => number;
  /** A mutation landed in the model — the grid needs a repaint. */
  onEditEnd: () => void;
  onTextUpdated: () => void;
  onError: (message: string) => void;
}

export function CellEditor(props: Props) {
  let textarea: HTMLTextAreaElement | undefined;
  let mask: HTMLDivElement | undefined;
  const [cursor, setCursor] = createSignal(props.originalText.length);

  const editingCell = createMemo(() => {
    props.revision();
    return props.workbookState.getEditingCell();
  });
  const text = createMemo(() =>
    editingCell() ? props.workbookState.getEditingText() : props.originalText,
  );

  // Only rewrite the textarea (and snap the caret to the end) when the value
  // changed from the OUTSIDE — a different cell selected, or a new edit session.
  // While the user types, the text flows back in unchanged, so the DOM value
  // already matches; rewriting here would yank the caret to the end on every
  // keystroke, and break clicking into the middle.
  createEffect(
    on(text, (value) => {
      if (!textarea || textarea.value === value) return;
      textarea.value = value;
      // When the value changed because a reference is being inserted at the
      // cursor (clicking or dragging cells on the grid), keep the caret right
      // after the inserted reference. Snapping to the end is only correct when
      // the reference sits at the end of the formula; in the middle it would
      // strand the caret past the rest of the text.
      const cell = editingCell();
      const referenced = cell?.referencedRange?.str;
      if (cell && referenced) {
        const caret = cell.cursorStart + referenced.length;
        textarea.setSelectionRange(caret, caret);
        setCursor(caret);
      } else {
        setCursor(value.length);
      }
    }),
  );

  // Grow the editor box to fit what has been typed, and take the caret whenever
  // this is the editor the workbook says has focus.
  createEffect(() => {
    const cell = editingCell();
    if (!cell) return;
    // Read the text so this re-runs as it is typed.
    text();
    if (mask) {
      const firstChild = mask.firstElementChild as HTMLElement | null;
      const scrollWidth = firstChild?.scrollWidth ?? 0;
      const scrollHeight = firstChild?.scrollHeight ?? 0;
      if (scrollWidth > cell.editorWidth - 5) cell.editorWidth = scrollWidth + 10;
      if (scrollHeight > cell.editorHeight) cell.editorHeight = scrollHeight;
    }
    if (cell.focus === props.type) {
      textarea?.focus({ preventScroll: true });
    }
  });

  const onKeyDown = createEditorKeyHandler({
    model: props.model,
    workbookState: props.workbookState,
    onEditEnd: () => props.onEditEnd(),
    onTextUpdated: () => props.onTextUpdated(),
    textarea: () => textarea ?? null,
  });

  const onInput = () => {
    const cell = props.workbookState.getEditingCell();
    if (!textarea || !cell) return;
    cell.text = textarea.value;
    cell.referencedRange = null;
    cell.cursorStart = textarea.selectionStart;
    cell.cursorEnd = textarea.selectionEnd;
    // Emptying a cell drops back to accept mode, so a following arrow key
    // navigates away instead of moving the caret.
    if (cell.text === "" && props.type === "cell") cell.mode = "accept";
    props.workbookState.setEditingCell(cell);
    props.workbookState.setActiveRanges(
      getFormulaSegments(props.model, cell.text).activeRanges,
    );
    setCursor(textarea.selectionStart);
    props.onTextUpdated();
  };

  const onBlur = () => {
    const cell = props.workbookState.getEditingCell();
    // Moving between the cell editor and the formula bar blurs one of them;
    // that is a focus change, not the end of the edit.
    if (props.type !== cell?.focus) return;
    if (textarea) textarea.value = "";
    props.model.setUserInput(
      cell.sheet,
      cell.row,
      cell.column,
      props.workbookState.getEditingText(),
    );
    props.workbookState.clearEditingCell();
    props.onEditEnd();
  };

  const segments = createMemo(() =>
    props.canEdit
      ? getFormulaSegments(props.model, text(), cursor()).segments
      : [{ text: text() }],
  );

  return (
    <div
      class="ic-editor"
      classList={{ "ic-editor--readonly": !props.canEdit }}
      hidden={editingCell() === null && props.type !== "formula-bar"}
    >
      <div class="ic-editor-mask" ref={mask}>
        <div style={{ display: "inline-block" }}>
          <For each={segments()}>
            {(segment) => (
              <Show
                when={!segment.hint}
                fallback={<span class="ic-insert-range-hint">{"  "}</span>}
              >
                <span style={segment.color ? { color: segment.color } : undefined}>
                  {segment.text}
                </span>
              </Show>
            )}
          </For>
        </div>
      </div>
      <textarea
        class="ic-editor-input"
        ref={textarea}
        rows={1}
        spellcheck={false}
        disabled={!props.canEdit}
        onKeyDown={(event) => {
          try {
            onKeyDown(event);
          } catch (error) {
            // A formula the engine rejects must not strand the editor: drop the
            // edit, leave the cell as it was, and report why.
            const cell = props.workbookState.getEditingCell();
            if (cell) props.model.setSelectedSheet(cell.sheet);
            props.workbookState.clearEditingCell();
            props.onEditEnd();
            props.onError(String(error));
          }
        }}
        onInput={onInput}
        onBlur={onBlur}
        onPointerDown={(event) => {
          if (!props.canEdit) return;
          // Clicking inside the text means the caret is being placed, so switch
          // out of accept mode (where arrows would navigate the grid instead).
          const cell = props.workbookState.getEditingCell();
          if (cell) {
            cell.mode = "edit";
            cell.focus = props.type;
            props.workbookState.setEditingCell(cell);
            event.stopPropagation();
          }
        }}
        onScroll={() => {
          if (mask && textarea) {
            mask.style.left = `-${textarea.scrollLeft}px`;
            mask.style.top = `-${textarea.scrollTop}px`;
          }
        }}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
        onPaste={(event) => event.stopPropagation()}
        onCopy={(event) => event.stopPropagation()}
        onCut={(event) => event.stopPropagation()}
        onDblClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}
