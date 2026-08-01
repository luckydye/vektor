// Ported from IronCalc `components/types.ts` at tag v0.8.3, MIT OR Apache-2.0.
// See ./README.md for what was changed and why.

export interface Area {
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
}

export interface Cell {
  row: number;
  column: number;
}
