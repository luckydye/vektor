/**
 * SQL predicates shared across the space tables.
 *
 * `document.archived` is loosely typed in stored data — the same column holds
 * `0`, `'0'`, `'0.0'`, `NULL` or `FALSE` depending on how the row was written —
 * so reads that care about it go through these rather than comparing directly.
 */

import { sql } from "drizzle-orm";
import { document } from "#db/schema/space.ts";

export const nonArchivedDocumentCondition = sql`
  (
    ${document.archived} = 0
    OR ${document.archived} = '0'
    OR ${document.archived} = '0.0'
    OR ${document.archived} IS NULL
    OR ${document.archived} = FALSE
  )
`;

export const archivedDocumentCondition = sql`
  (
    ${document.archived} = 1
    OR ${document.archived} = '1'
    OR ${document.archived} = '1.0'
    OR ${document.archived} = TRUE
  )
`;

/** The same predicate for a raw `sql` selection, which has no column object. */
export function nonArchivedColumnCondition(column: string) {
  return sql.raw(
    `(${column} = 0 OR ${column} = '0' OR ${column} = '0.0' OR ${column} IS NULL OR ${column} = FALSE)`,
  );
}
