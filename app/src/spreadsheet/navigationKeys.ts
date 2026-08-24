// Ported from IronCalc `components/Workbook/useKeyboardNavigation.ts` at tag
// v0.8.3, MIT OR Apache-2.0. De-Reactified into a plain handler factory, and the
// styling (Ctrl+B/I/U) and sheet-switching (Alt+Arrow) shortcuts dropped: an
// embedded table has no second sheet. See ./grid/README.md.

import { isEditingKey, isNavigationKey, type NavigationKey } from "./grid/address.ts";

interface Options {
  onCellsDeleted: () => void;
  onExpandAreaSelectedKeyboard: (
    key: "ArrowRight" | "ArrowLeft" | "ArrowUp" | "ArrowDown",
  ) => void;
  onEditKeyPressStart: (initText: string) => void;
  onCellEditStart: () => void;
  onNavigationToEdge: (direction: NavigationKey) => void;
  onPageDown: () => void;
  onPageUp: () => void;
  onArrowDown: () => void;
  onArrowUp: () => void;
  onArrowLeft: () => void;
  onArrowRight: () => void;
  onKeyHome: () => void;
  onKeyEnd: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onEscape: () => void;
  onSelectColumn: () => void;
  onSelectRow: () => void;
  /** When false, editing/mutation keys are ignored (navigation still works). */
  canEdit: () => boolean;
  root: () => HTMLElement | null;
}

// # Keyboard accessibility:
// * ArrowKeys: navigation
// * Enter: ArrowDown (Excel behaviour not g-sheets)
// * Tab: arrow right
// * Shift+Tab: arrow left
// * Home/End: First/last column
// * Shift+Arrows: selection
// * Ctrl+Arrows: navigating to edge
// * Ctrl+Home/End: navigation to end
// * PagDown/Up scroll Down/Up
// * Ctrl+z/y: undo/redo
// * F2: start editing
// * Ctrl+Space: select column
// * Shift+Space: select row
//
// # Not implemented yet:
// * Ctrl+a: select all (continuous area around the selection, if it exists,
//   otherwise select whole sheet)
// * Ctrl+Shift+Arrows: select to edge
// * Ctrl+Shift+Home/End: select to end
// * Ctrl+Shift++: (after selecting) insert row/column (also Alt+I, R or C)
// * Ctrl+-: (after selecting) delete row/column

// References:
// In Google Sheets: Ctrl+/ shows the list of keyboard shortcuts
// https://support.google.com/docs/answer/181110
// https://support.microsoft.com/en-us/office/keyboard-shortcuts-in-excel-1798d9d5-842a-42b8-9c99-9b7213f0040f

export function createNavigationKeyHandler(
  options: Options,
): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    const { key } = event;
    const lowerKey = key.toLowerCase();
    const root = options.root();
    if (!root || event.target !== root) {
      return;
    }
    const canEdit = options.canEdit();
    const isCtrl = event.metaKey || event.ctrlKey;
    const isShift = event.shiftKey;
    const isAlt = event.altKey;
    if (isCtrl && !isShift && !isAlt) {
      // Ctrl+...
      switch (lowerKey) {
        case "z": {
          if (canEdit) {
            options.onUndo();
          }
          event.stopPropagation();
          event.preventDefault();
          break;
        }
        case "y": {
          if (canEdit) {
            options.onRedo();
          }
          event.stopPropagation();
          event.preventDefault();
          break;
        }
        case "a": {
          // TODO: Area selection. CTRL+A should select "continuous" area around the selection,
          // if it does exist then whole sheet is selected.
          event.stopPropagation();
          event.preventDefault();
          break;
        }
        case " ": {
          options.onSelectColumn();
          event.stopPropagation();
          event.preventDefault();
          break;
        }
        // No default
      }
      if (isNavigationKey(key)) {
        // Ctrl+Arrows, Ctrl+Home/End
        options.onNavigationToEdge(key);
        event.stopPropagation();
        event.preventDefault();
      }
      return;
    }
    if (isCtrl && isShift && !isAlt) {
      // Ctrl+Shift+...
      if (lowerKey === "z") {
        if (canEdit) {
          options.onRedo();
        }
        event.stopPropagation();
        event.preventDefault();
      }
      return;
    }
    if (isShift && !isAlt && !isCtrl) {
      // Shift+...
      switch (key) {
        case " ": {
          options.onSelectRow();
          event.stopPropagation();
          event.preventDefault();
          break;
        }
        case "ArrowRight":
        case "ArrowLeft":
        case "ArrowUp":
        case "ArrowDown": {
          options.onExpandAreaSelectedKeyboard(key);
          break;
        }
        case "Tab": {
          options.onArrowLeft();
          event.stopPropagation();
          event.preventDefault();
          break;
        }
      }
    }
    if (isCtrl || isAlt) {
      // Other combinations with Ctrl or Alt are not handled
      return;
    }

    if (canEdit && (isEditingKey(key) || key === "Backspace")) {
      const initText = key === "Backspace" ? "" : key;
      options.onEditKeyPressStart(initText);
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    if (isShift) {
      // Other combinations with Shift are not handled
      return;
    }
    if (key === "F2" && canEdit) {
      options.onCellEditStart();
      event.stopPropagation();
      event.preventDefault();
      return;
    }
    // Worksheet Navigation
    switch (key) {
      case "ArrowRight":
      case "Tab": {
        options.onArrowRight();
        break;
      }
      case "ArrowLeft": {
        options.onArrowLeft();
        break;
      }
      case "ArrowDown":
      case "Enter": {
        options.onArrowDown();
        break;
      }
      case "ArrowUp": {
        options.onArrowUp();
        break;
      }
      case "End": {
        options.onKeyEnd();
        break;
      }
      case "Home": {
        options.onKeyHome();
        break;
      }
      case "Delete": {
        if (canEdit) {
          options.onCellsDeleted();
        }
        break;
      }
      case "PageDown": {
        options.onPageDown();
        break;
      }
      case "PageUp": {
        options.onPageUp();
        break;
      }
      case "Escape": {
        options.onEscape();
      }
      // No default
    }
    event.stopPropagation();
    event.preventDefault();
  };
}
