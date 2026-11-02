/**
 * What a filter-only search asks of the `document` table, as SQL conditions
 * over a document aliased `d`: type, parent, `_date` windows, the readable set
 * and property filters. The in-memory rule these mirror is `matchesFilters` in
 * `search.ts`.
 */

import { type SQL, sql } from "drizzle-orm";
import { canonicalPropertyKey } from "#documents/properties.ts";
import {
  DOCUMENT_TYPE_SQL,
  nonArchivedColumnCondition,
  STORED_ARRAY_SQL,
} from "./documentSql.ts";
import type { PropertyValueFilter } from "./search.ts";

/** The span of `updated_at` a `_date` filter value stands for, in epoch milliseconds. */
export interface DateWindow {
  from: number;
  before: number;
}

export function dateFilterWindow(value: string | null, now: Date): DateWindow | null {
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const weekStart = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const monthStart = now.getTime() - 30 * 24 * 60 * 60 * 1000;

  if (value?.includes("/")) {
    const [startText, endText] = value.split("/");
    const start = startText ? new Date(startText).getTime() : Number.NaN;
    const end = endText ? new Date(endText) : null;
    if (end) end.setDate(end.getDate() + 1);
    const endTime = end?.getTime() ?? Number.NaN;
    return {
      from: Number.isNaN(start) ? -Infinity : start,
      before: Number.isNaN(endTime) ? Infinity : endTime,
    };
  }
  switch (value) {
    case "today":
      return { from: todayStart, before: Infinity };
    case "week":
      return { from: weekStart, before: todayStart };
    case "month":
      return { from: monthStart, before: weekStart };
    case "older":
      return { from: -Infinity, before: monthStart };
    default:
      return null;
  }
}

export function inDateWindows(time: number, windows: DateWindow[]): boolean {
  return windows.every((window) => time >= window.from && time < window.before);
}

/** Case-insensitive matching in SQL is ASCII-only, so only an ASCII value is matched there. */
export function isSqlComparable(filter: PropertyValueFilter): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the ASCII range
  return filter.value === null || /^[\x00-\x7f]*$/.test(filter.value);
}

/** Stored property keys compare by `canonicalPropertyKey`, which this mirrors. */
const PROPERTY_KEY_SQL = sql.raw(
  "CASE WHEN substr(trim(p.key), 1, 1) = '_' THEN trim(p.key) ELSE lower(trim(p.key)) END",
);

/** Whether the document has a property under `key` (any value). */
function hasPropertyCondition(key: string) {
  return sql`EXISTS (
    SELECT 1 FROM property p
    WHERE p.document_id = d.id AND ${PROPERTY_KEY_SQL} = ${canonicalPropertyKey(key)}
  )`;
}

/**
 * `matchesFilters`' property rule in SQL. A stored value is plain text or a
 * JSON array of strings; an array matches when any element does, and a value
 * that merely starts with `[` is plain text.
 */
function propertyValueCondition(filter: PropertyValueFilter) {
  const key = canonicalPropertyKey(filter.key);
  if (filter.value === null) {
    return sql`EXISTS (
      SELECT 1 FROM property p
      WHERE p.document_id = d.id AND ${PROPERTY_KEY_SQL} = ${key}
        AND p.value != '' AND p.value != '[]'
    )`;
  }
  const expected = filter.value.toLowerCase();
  return sql`EXISTS (
    SELECT 1 FROM property p
    WHERE p.document_id = d.id AND ${PROPERTY_KEY_SQL} = ${key}
      AND CASE
        WHEN ${STORED_ARRAY_SQL}
          THEN EXISTS (
            SELECT 1 FROM json_each(p.value) WHERE lower(CAST(value AS TEXT)) = ${expected}
          )
        ELSE lower(p.value) = ${expected}
      END
  )`;
}


export interface DocumentFilters {
  /** The caller's readable documents, or null for an unrestricted view. */
  readable: Set<string> | null;
  parentId?: string;
  typeFilters: PropertyValueFilter[];
  /** Property filters SQL can decide (see `isSqlComparable`). */
  propertyFilters: PropertyValueFilter[];
  /** Keys a filter needs present, for filters settled in memory afterwards. */
  requiredKeys: string[];
  dateWindows: DateWindow[];
}

/** Every condition a live document must meet; AND them in a `WHERE`. */
export function documentFilterConditions(filters: DocumentFilters): SQL[] {
  const conditions = [nonArchivedColumnCondition("d.archived")];
  for (const filter of filters.typeFilters) {
    if (filter.value !== null) {
      conditions.push(sql`${DOCUMENT_TYPE_SQL} = ${filter.value.toLowerCase()}`);
    }
  }
  if (filters.parentId !== undefined) {
    conditions.push(sql`d.parent_id = ${filters.parentId}`);
  }
  for (const window of filters.dateWindows) {
    if (window.from !== -Infinity) {
      conditions.push(sql`CAST(d.updated_at AS REAL) >= ${window.from / 1000}`);
    }
    if (window.before !== Infinity) {
      conditions.push(sql`CAST(d.updated_at AS REAL) < ${window.before / 1000}`);
    }
  }
  if (filters.readable) {
    conditions.push(
      sql`d.id IN (SELECT value FROM json_each(${JSON.stringify([...filters.readable])}))`,
    );
  }
  for (const filter of filters.propertyFilters) {
    conditions.push(propertyValueCondition(filter));
  }
  for (const key of filters.requiredKeys) conditions.push(hasPropertyCondition(key));
  return conditions;
}
