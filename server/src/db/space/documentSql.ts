/**
 * SQL fragments about what a document row is, shared by every query that
 * lists documents. A leaf module: queries import it, never the reverse.
 */

import { sql } from "drizzle-orm";
import { document } from "#db/schema/space.ts";

/**
 * `archived` is loosely typed in stored data (`0`, `'0'`, `'0.0'`, `FALSE`), so
 * it is read as the integer it means. The `document_live_*` indexes (migration
 * `live-document-indexes`) are partial on this same expression: keep them in
 * step, or queries stop using them.
 */
export const nonArchivedDocumentCondition = sql`CAST(${document.archived} AS INTEGER) = 0`;

/** The same, for a raw `sql` selection with no column object. */
export function nonArchivedColumnCondition(column: string) {
  return sql.raw(`CAST(${column} AS INTEGER) = 0`);
}

/**
 * A document's type as filters see it: no type is a plain document, compared
 * lower-cased. The `document_live_type_updated_idx` index is built on this
 * expression, over a document aliased `d`.
 */
export const DOCUMENT_TYPE_SQL = sql.raw(
  "lower(coalesce(nullif(d.type, ''), 'document'))",
);

/**
 * Whether a stored property value is a JSON array of strings, as opposed to
 * plain text that merely starts with `[`. For a property aliased `p`.
 */
export const STORED_ARRAY_SQL = sql.raw(
  "(p.value LIKE '[%' AND json_valid(p.value) AND json_type(p.value) = 'array')",
);
