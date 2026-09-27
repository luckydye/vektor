/**
 * Point filters, shared by stored reads, queries and the live event bus so a
 * subscription and a query with the same `where` select the same points.
 */

import {
  bloomMayContain,
  type ColumnStats,
  type ObjectHeader,
  pointValue,
  type SeriesPoint,
  type SeriesValue,
} from "./format.ts";
import { SeriesInputError } from "./limits.ts";

export type SeriesPredicate =
  | {
      column: string;
      op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte";
      value: number | string;
    }
  | { column: string; op: "in"; value: Array<number | string> }
  | { column: string; op: "contains"; value: string }
  | { column: string; op: "exists" };

/** Why an object could be skipped without reading its body. */
export type PruneReason = "range" | "missing" | "stats" | "values" | "bloom";

const COMPARISONS = new Set(["eq", "ne", "lt", "lte", "gt", "gte"]);
const MAX_PREDICATES = 32;

function isScalar(value: unknown): value is number | string {
  return (
    (typeof value === "number" && Number.isFinite(value)) || typeof value === "string"
  );
}

export function parsePredicates(input: unknown): SeriesPredicate[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_PREDICATES) {
    throw new SeriesInputError(`where must be an array of at most ${MAX_PREDICATES}`);
  }
  return input.map((raw): SeriesPredicate => {
    const predicate = raw as Record<string, unknown>;
    const { column, op, value } = predicate ?? {};
    if (typeof column !== "string" || column === "") {
      throw new SeriesInputError("Each predicate needs a column");
    }
    if (typeof op === "string" && COMPARISONS.has(op) && isScalar(value)) {
      return { column, op: op as "eq", value };
    }
    if (op === "in" && Array.isArray(value) && value.every(isScalar)) {
      return { column, op, value };
    }
    if (op === "contains" && typeof value === "string") return { column, op, value };
    if (op === "exists") return { column, op };
    throw new SeriesInputError(`Invalid predicate on "${column}"`);
  });
}

function compare(
  actual: SeriesValue | undefined,
  op: "eq" | "ne" | "lt" | "lte" | "gt" | "gte",
  expected: number | string,
): boolean {
  if (actual === undefined || actual === null) return false;
  if (typeof actual !== typeof expected) return op === "ne";
  switch (op) {
    case "eq":
      return actual === expected;
    case "ne":
      return actual !== expected;
    case "lt":
      return actual < expected;
    case "lte":
      return actual <= expected;
    case "gt":
      return actual > expected;
    case "gte":
      return actual >= expected;
  }
}

export function matchesPredicate(
  point: SeriesPoint,
  predicate: SeriesPredicate,
): boolean {
  const actual = pointValue(point, predicate.column);
  switch (predicate.op) {
    case "exists":
      return actual !== undefined;
    case "contains":
      return typeof actual === "string" && actual.includes(predicate.value);
    case "in":
      return predicate.value.some((value) => compare(actual, "eq", value));
    default:
      return compare(actual, predicate.op, predicate.value);
  }
}

export function matchesAll(point: SeriesPoint, predicates: SeriesPredicate[]): boolean {
  return predicates.every((predicate) => matchesPredicate(point, predicate));
}

/** Whether some non-null value summarised by `stats` could satisfy `predicate`. */
function statsMayMatch(
  stats: ColumnStats,
  predicate: SeriesPredicate,
): PruneReason | null {
  if (predicate.op === "exists") return null;
  const candidates = predicate.op === "in" ? predicate.value : [predicate.value];
  const op = predicate.op === "in" ? "eq" : predicate.op;

  if (stats.type === "number") {
    const numbers = candidates.filter(
      (value): value is number => typeof value === "number",
    );
    if (op === "contains") return "stats";
    if (op === "ne") return null;
    const fits = numbers.some((value) => {
      switch (op) {
        case "eq":
          return stats.min <= value && value <= stats.max;
        case "lt":
          return stats.min < value;
        case "lte":
          return stats.min <= value;
        case "gt":
          return stats.max > value;
        default:
          return stats.max >= value;
      }
    });
    return fits ? null : "stats";
  }

  if (stats.type === "string") {
    const strings = candidates.filter(
      (value): value is string => typeof value === "string",
    );
    if (op === "ne") return null;
    if (stats.values) {
      const values = stats.values;
      const fits = strings.some((expected) =>
        values.some((actual) =>
          op === "contains"
            ? actual.includes(expected)
            : compare(actual, op as "eq", expected),
        ),
      );
      return fits ? null : "values";
    }
    if (op === "eq" && stats.bloom) {
      const bloom = stats.bloom;
      return strings.some((value) => bloomMayContain(bloom, value)) ? null : "bloom";
    }
    return strings.length === 0 && op !== "contains" ? "stats" : null;
  }

  return null;
}

/** Why no point in the object can match, or null when some might. */
export function pruneReason(
  header: ObjectHeader,
  from: number,
  to: number,
  predicates: SeriesPredicate[],
): PruneReason | null {
  if (header.to < from || header.from >= to) return "range";
  for (const predicate of predicates) {
    const stats: ColumnStats | undefined =
      predicate.column === "ts"
        ? { type: "number", nulls: 0, min: header.from, max: header.to }
        : header.columns[predicate.column];
    if (!stats || stats.nulls === header.count) return "missing";
    const reason = statsMayMatch(stats, predicate);
    if (reason) return reason;
  }
  return null;
}
