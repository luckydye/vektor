/**
 * Stored queries: prune objects by their headers, refuse before reading bodies
 * when too much survives, then bucket. Every aggregate is mergeable, so rollup
 * objects can answer the same queries later.
 */

import type { SpaceStore } from "#db/client/store.ts";
import { requireSeries } from "./catalog.ts";
import { parseSeriesFilter } from "./filter.ts";
import {
  compareStoredPoints,
  type ObjectHeader,
  pointValue,
  type SeriesValue,
  type StoredPoint,
} from "./format.ts";
import {
  SERIES_READ_DEADLINE_MS,
  SeriesInputError,
  seriesLimits,
  withDeadline,
} from "./limits.ts";
import {
  matchesAll,
  type PruneReason,
  parsePredicates,
  pruneReason,
  type SeriesPredicate,
} from "./predicates.ts";
import {
  listWindow,
  mapLimited,
  readHeader,
  readObject,
  resolveWindow,
  windowsBetween,
} from "./store.ts";

export interface SeriesQuery {
  from: number;
  to: number;
  where?: SeriesPredicate[];
  /** Bucket width in ms; omitted, the whole range is one bucket. */
  every?: number;
  groupBy?: { column: string };
  select: SeriesAggregate[];
}

export type SeriesAggregate =
  | { fn: "count" }
  | { fn: "sum" | "avg" | "min" | "max" | "first" | "last"; column: string };

export interface SeriesQueryRow {
  bucket: number;
  group?: SeriesValue;
  values: SeriesValue[];
}

export interface SeriesQueryResult {
  rows: SeriesQueryRow[];
  scanned: {
    objects: number;
    prunedObjects: number;
    points: number;
    source: "raw";
    prunedBy: Partial<Record<PruneReason, number>>;
    scannedFor: number;
  };
}

const AGGREGATES = new Set(["count", "sum", "avg", "min", "max", "first", "last"]);
const MAX_SELECT = 32;

export function parseSeriesQuery(input: unknown): SeriesQuery {
  const raw = (input ?? {}) as Record<string, unknown>;
  const { from, to, every, groupBy, select } = raw;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    (from as number) >= (to as number)
  ) {
    throw new SeriesInputError("from and to must be integers (ms) with from < to");
  }
  if (every !== undefined && (!Number.isSafeInteger(every) || (every as number) <= 0)) {
    throw new SeriesInputError("every must be a positive integer (ms)");
  }
  const group = groupBy as { column?: unknown } | undefined;
  if (group !== undefined && (typeof group.column !== "string" || group.column === "")) {
    throw new SeriesInputError("groupBy needs a column");
  }
  if (!Array.isArray(select) || select.length === 0 || select.length > MAX_SELECT) {
    throw new SeriesInputError(`select must name 1-${MAX_SELECT} aggregates`);
  }
  const aggregates = select.map((entry): SeriesAggregate => {
    const { fn, column } = (entry ?? {}) as Record<string, unknown>;
    if (typeof fn !== "string" || !AGGREGATES.has(fn)) {
      throw new SeriesInputError(`Unknown aggregate "${String(fn)}"`);
    }
    if (fn === "count") return { fn };
    if (typeof column !== "string" || column === "") {
      throw new SeriesInputError(`${fn} needs a column`);
    }
    return { fn: fn as "sum", column };
  });
  return {
    from: from as number,
    to: to as number,
    where: [...parsePredicates(raw.where), ...parseFilterField(raw.filter)],
    every: every as number | undefined,
    groupBy: group ? { column: group.column as string } : undefined,
    select: aggregates,
  };
}

function parseFilterField(filter: unknown): SeriesPredicate[] {
  if (filter === undefined) return [];
  if (typeof filter !== "string") throw new SeriesInputError("filter must be a string");
  return parseSeriesFilter(filter);
}

/** Mergeable state of one aggregate in one bucket and group. */
type AggregateState =
  | { fn: "count"; count: number }
  | { fn: "sum" | "avg"; sum: number; count: number }
  | { fn: "min" | "max"; value: number | null }
  | { fn: "first" | "last"; value: SeriesValue; at: StoredPoint | null };

function initialState(aggregate: SeriesAggregate): AggregateState {
  switch (aggregate.fn) {
    case "count":
      return { fn: "count", count: 0 };
    case "sum":
    case "avg":
      return { fn: aggregate.fn, sum: 0, count: 0 };
    case "min":
    case "max":
      return { fn: aggregate.fn, value: null };
    case "first":
    case "last":
      return { fn: aggregate.fn, value: null, at: null };
  }
}

function accumulate(
  state: AggregateState,
  aggregate: SeriesAggregate,
  point: StoredPoint,
): void {
  if (state.fn === "count") {
    state.count++;
    return;
  }
  const value = pointValue(point, (aggregate as { column: string }).column);
  if (value === undefined || value === null) return;
  if (state.fn === "first" || state.fn === "last") {
    const order = state.at === null ? 0 : compareStoredPoints(point, state.at);
    if (state.at === null || (state.fn === "first" ? order < 0 : order > 0)) {
      state.value = value;
      state.at = point;
    }
    return;
  }
  if (typeof value !== "number") return;
  if (state.fn === "sum" || state.fn === "avg") {
    state.sum += value;
    state.count++;
  } else if (state.fn === "min" || state.fn === "max") {
    const pick = state.fn === "min" ? Math.min : Math.max;
    state.value = state.value === null ? value : pick(state.value, value);
  }
}

function finish(state: AggregateState): SeriesValue {
  switch (state.fn) {
    case "count":
      return state.count;
    case "sum":
      return state.sum;
    case "avg":
      return state.count === 0 ? null : state.sum / state.count;
    default:
      return state.value;
  }
}

function compareGroups(a: SeriesValue | undefined, b: SeriesValue | undefined): number {
  const left = JSON.stringify(a ?? null);
  const right = JSON.stringify(b ?? null);
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Answer `query` from the series' objects. `prune: false` reads every object
 * the range lists, which must produce the same rows.
 */
export async function querySeries(
  store: SpaceStore,
  name: string,
  query: SeriesQuery,
  options: { prune?: boolean } = {},
): Promise<SeriesQueryResult> {
  const started = Date.now();
  const limits = seriesLimits();
  const where = query.where ?? [];
  const every = query.every ?? query.to - query.from;
  const buckets = Math.ceil((query.to - query.from) / every);
  if (buckets > limits.maxBuckets) {
    throw new SeriesInputError(
      `The query spans ${buckets} buckets; at most ${limits.maxBuckets} are allowed`,
      422,
    );
  }
  const row = await requireSeries(store, name);
  const { spaceId } = store;

  const run = async (): Promise<SeriesQueryResult> => {
    const windows = windowsBetween(row, query.from, query.to);
    const keys = (
      await mapLimited(
        windows,
        async (window) =>
          (
            await resolveWindow(spaceId, await listWindow(spaceId, row.id, window))
          ).keys,
      )
    ).flat();
    const headers: Array<{ key: string; header: ObjectHeader }> = await mapLimited(
      keys,
      async (key) => ({ key, header: await readHeader(spaceId, key) }),
    );

    const prunedBy: Partial<Record<PruneReason, number>> = {};
    const surviving = headers.filter(({ header }) => {
      if (options.prune === false) return true;
      const reason = pruneReason(header, query.from, query.to, where);
      if (reason) prunedBy[reason] = (prunedBy[reason] ?? 0) + 1;
      return reason === null;
    });
    const points = surviving.reduce((sum, { header }) => sum + header.count, 0);
    if (points > limits.maxScanPoints) {
      throw new SeriesInputError(
        `The query would scan ${points} points; at most ${limits.maxScanPoints} are allowed`,
        422,
      );
    }

    const groups = new Map<string, SeriesQueryRow & { states: AggregateState[] }>();
    const groupValues = new Set<string>();
    for (const { key } of surviving) {
      const object = await readObject(spaceId, key);
      for (const point of object.points) {
        if (point.ts < query.from || point.ts >= query.to) continue;
        if (!matchesAll(point, where)) continue;
        const bucket = query.from + Math.floor((point.ts - query.from) / every) * every;
        const group = query.groupBy
          ? (pointValue(point, query.groupBy.column) ?? null)
          : undefined;
        const groupKey = JSON.stringify(group ?? null);
        groupValues.add(groupKey);
        if (groupValues.size > limits.maxGroups) {
          throw new SeriesInputError(
            `The query has more than ${limits.maxGroups} groups`,
            422,
          );
        }
        const id = `${bucket}|${groupKey}`;
        let entry = groups.get(id);
        if (!entry) {
          entry = {
            bucket,
            ...(query.groupBy && { group }),
            values: [],
            states: query.select.map(initialState),
          };
          groups.set(id, entry);
        }
        entry.states.forEach((state, index) => {
          accumulate(state, query.select[index], point);
        });
      }
    }

    const rows = [...groups.values()]
      .sort((a, b) => a.bucket - b.bucket || compareGroups(a.group, b.group))
      .map(({ bucket, group, states }) => ({
        bucket,
        ...(query.groupBy && { group }),
        values: states.map(finish),
      }));
    return {
      rows,
      scanned: {
        objects: headers.length,
        prunedObjects: headers.length - surviving.length,
        points,
        source: "raw",
        prunedBy,
        scannedFor: Date.now() - started,
      },
    };
  };
  return withDeadline(run(), SERIES_READ_DEADLINE_MS, "Series query");
}
