// Ported from IronCalc `components/Editor/util.tsx` at tag v0.8.3, MIT OR
// Apache-2.0. `getFormulaHTML` returned React elements; here it returns the
// segments to render, so the editor's markup belongs to the Solid component and
// this stays framework-free. See ./grid/README.md.

import {
  type CellArrayStructure,
  getTokens,
  type Model,
  type Range,
  type Reference,
  type TokenType,
} from "@ironcalc/wasm";
import { getColor } from "./grid/colors.ts";
import type { ActiveRange } from "./grid/workbookState.ts";

/** One run of formula text, tinted when it names a cell or range. */
export interface FormulaSegment {
  text: string;
  color?: string;
  /**
   * The caret sits where a reference could be inserted (`=SUM(|`). Rendered as
   * a marker rather than text: it hints that an arrow key or a click on the
   * grid will put a reference here.
   */
  hint?: true;
}

function sliceString(text: string, startScalar: number, endScalar: number): string {
  return Array.from(text).slice(startScalar, endScalar).join("");
}

export function tokenIsReferenceType(token: TokenType): token is Reference {
  return typeof token === "object" && "Reference" in token;
}

export function tokenIsRangeType(token: TokenType): token is Range {
  return typeof token === "object" && "Range" in token;
}

function isDynamicAnchor(
  structure: CellArrayStructure,
): structure is { DynamicAnchor: [number, number] } {
  return typeof structure === "object" && "DynamicAnchor" in structure;
}

// A token that begins an operand: a value, a name/function, a reference/range,
// or an opening delimiter of a grouped expression or array. When such a token
// sits right after the caret there is already an operand there, so the caret is
// not in an empty slot and the reference-insertion hint must not be shown (e.g.
// `=|SUM(...)`, where the function name follows the caret).
function tokenStartsOperand(token: TokenType): boolean {
  if (typeof token === "object") {
    return (
      "Ident" in token ||
      "Number" in token ||
      "String" in token ||
      "Boolean" in token ||
      "Reference" in token ||
      "Range" in token
    );
  }
  return token === "LeftParenthesis" || token === "LeftBrace";
}

/** The argument separator tokens (`,` in English locales, `;` otherwise). */
function tokenIsArgumentSeparator(token: TokenType): boolean {
  return token === "Comma" || token === "Semicolon";
}

/**
 * Whether the cursor sits at a position where the formula grammar would accept
 * a reference or range, so that arrow keys / clicking a cell can insert one.
 * This asks the engine for a partial parse of the formula up to the cursor.
 */
export function isInReferenceMode(model: Model, text: string, cursor: number): boolean {
  if (!text.startsWith("=")) {
    return false;
  }
  try {
    const [sheet, row, column] = model.getSelectedCell();
    // Convert the UTF-16 cursor to a scalar offset
    const scalarCursor = Array.from(text.slice(0, cursor)).length;
    const { expecting } = model.getFormulaCompletion(
      sheet,
      row,
      column,
      text,
      scalarCursor,
    );
    return expecting.includes("Range");
  } catch (error) {
    console.error("Error in isInReferenceMode:", error);
    return false;
  }
}

const HINT: FormulaSegment = { text: "  ", hint: true };

/**
 * Splits `text` into the runs to render, and reports the ranges it refers to so
 * the grid can outline them in matching colours.
 */
export function getFormulaSegments(
  model: Model,
  text: string,
  cursor?: number,
): { segments: FormulaSegment[]; activeRanges: ActiveRange[] } {
  const activeRanges: ActiveRange[] = [];
  if (!text.startsWith("=")) {
    const segments: FormulaSegment[] = [{ text }];
    // A trailing newline needs a character after it or the mask collapses.
    if (text.endsWith("\n")) segments.push({ text: "\n" });
    return { segments, activeRanges };
  }

  const segments: FormulaSegment[] = [{ text: "=" }];
  const formula = text.slice(1);
  const tokens = getTokens(formula);
  const usedColors: Record<string, string> = {};
  let colorCount = 0;
  const sheet = model.getSelectedSheet();
  const sheetList = model.getWorksheetsProperties().map((properties) => properties.name);

  const colorFor = (key: string): string => {
    let color = usedColors[key];
    if (!color) {
      color = getColor(colorCount);
      usedColors[key] = color;
      colorCount += 1;
    }
    return color;
  };

  // The reference-insertion hint is shown when the caret is in "reference mode"
  // and no reference already sits immediately after it. We resolve where among
  // the segments it belongs by finding the first token starting at/after it.
  const inReferenceMode = cursor !== undefined && isInReferenceMode(model, text, cursor);
  // Caret as a scalar offset into `formula` (drop the leading `=`).
  const scalarCursor =
    cursor === undefined ? -1 : Array.from(text.slice(0, cursor)).length - 1;
  let hintHandled = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (!entry) continue;
    const { token, start, end } = entry;

    // The hint belongs right before the first token that begins at/after the
    // caret. Suppress it when the caret is not actually in an empty operand
    // slot:
    //   * the following token already starts an operand (`=|SUM(...)`,
    //     `=A1+|B2`) — the reference/value is there, nothing to insert;
    //   * the caret sits in an empty trailing argument, i.e. right after a
    //     separator and immediately before `)` (`=SUM(A1,|)`). Note this is
    //     distinct from `=SUM(|)`, whose previous token is `(`, not a
    //     separator, and which does mark an insertable first argument.
    if (inReferenceMode && !hintHandled && start >= scalarCursor) {
      const previousToken = index > 0 ? tokens[index - 1]?.token : undefined;
      const emptyTrailingArgument =
        token === "RightParenthesis" &&
        previousToken !== undefined &&
        tokenIsArgumentSeparator(previousToken);
      if (!tokenStartsOperand(token) && !emptyTrailingArgument) {
        segments.push(HINT);
      }
      hintHandled = true;
    }

    const next = tokens[index + 1];
    if (tokenIsReferenceType(token) && next && next.token === "Spill") {
      // The spill operator belongs to the reference before it (`A27#`).
      const { sheet: refSheet, row, column } = token.Reference;
      const sheetIndex = refSheet ? sheetList.indexOf(refSheet) : sheet;
      const structure = model.getCellArrayStructure(sheetIndex, row, column);
      const text = sliceString(formula, start, next.end);
      if (isDynamicAnchor(structure)) {
        const [width, height] = structure.DynamicAnchor;
        const rowEnd = row + height - 1;
        const columnEnd = column + width - 1;
        const color = colorFor(`${sheetIndex}-${row}-${column}:${rowEnd}-${columnEnd}`);
        segments.push({ text, color });
        activeRanges.push({
          sheet: sheetIndex,
          rowStart: row,
          columnStart: column,
          rowEnd,
          columnEnd,
          color,
        });
      } else {
        // Not a dynamic anchor, so it is just text.
        segments.push({ text });
      }
      index += 1;
    } else if (tokenIsReferenceType(token)) {
      const { sheet: refSheet, row, column } = token.Reference;
      const sheetIndex = refSheet ? sheetList.indexOf(refSheet) : sheet;
      const color = colorFor(`${sheetIndex}-${row}-${column}`);
      segments.push({ text: sliceString(formula, start, end), color });
      activeRanges.push({
        sheet: sheetIndex,
        rowStart: row,
        columnStart: column,
        rowEnd: row,
        columnEnd: column,
        color,
      });
    } else if (tokenIsRangeType(token)) {
      let {
        left: { row: rowStart, column: columnStart },
        right: { row: rowEnd, column: columnEnd },
      } = token.Range;
      const refSheet = token.Range.sheet;
      const sheetIndex = refSheet ? sheetList.indexOf(refSheet) : sheet;
      const color = colorFor(
        `${sheetIndex}-${rowStart}-${columnStart}:${rowEnd}-${columnEnd}`,
      );
      if (rowStart > rowEnd) [rowStart, rowEnd] = [rowEnd, rowStart];
      if (columnStart > columnEnd) [columnStart, columnEnd] = [columnEnd, columnStart];
      segments.push({ text: sliceString(formula, start, end), color });
      activeRanges.push({
        sheet: sheetIndex,
        rowStart,
        columnStart,
        rowEnd,
        columnEnd,
        color,
      });
    } else {
      segments.push({ text: sliceString(formula, start, end) });
    }
  }

  // The caret sits past every token (e.g. `=SUM(`): the hint goes at the end.
  if (inReferenceMode && !hintHandled) {
    segments.push(HINT);
  }
  if (text.endsWith("\n")) {
    segments.push({ text: "\n" });
  }
  return { segments, activeRanges };
}
