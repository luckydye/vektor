/**
 * What a peer's cursor looks like in a spreadsheet: the range they have
 * selected. Sent through the same presence room the editor and canvas use, so
 * it needs no protocol of its own — `PresenceEnvelope.state` is opaque to the
 * server.
 */

import type { PresenceUser } from "#realtime/protocol.ts";

/** A peer's selection, in the engine's 1-based coordinates. */
export interface SheetSelection {
  row: number;
  column: number;
  rowEnd: number;
  columnEnd: number;
}

export interface RemoteSelection {
  clientId: string;
  user: PresenceUser;
  selection: SheetSelection;
}

export function sameSelection(
  a: SheetSelection | null,
  b: SheetSelection | null,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.row === b.row &&
    a.column === b.column &&
    a.rowEnd === b.rowEnd &&
    a.columnEnd === b.columnEnd
  );
}

/** The colour a peer is drawn in; falls back to the avatar colour. */
export function presenceColor(entry: RemoteSelection): string {
  return entry.user.color ?? "#8CA0B3";
}
