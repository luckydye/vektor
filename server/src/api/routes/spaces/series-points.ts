import { Permission } from "#acl/permissions.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  parsePaginationParams,
  parseQueryInt,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { ingestPoints } from "#events/events.ts";
import { parseSeriesFilter } from "#series/filter.ts";
import { SeriesInputError } from "#series/limits.ts";
import { parsePredicates } from "#series/predicates.ts";
import { readSeriesPoints } from "#series/store.ts";
import { requireSeriesAccess, seriesErrorResponse } from "./seriesAccess.ts";

/**
 * Append points to a series
 *
 * Each point is `{ ts, type, fields }`, `ts` in ms. The batch is refused whole
 * if any point is invalid, older than retention or too far in the future.
 *
 * @tag Series
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const { store, series } = await requireSeriesAccess(context, Permission.EDITOR);
      const body = await parseJsonBody<{ points?: unknown }>(context.req.raw);
      if (!Array.isArray(body.points))
        return badRequestResponse("points must be an array");
      return jsonResponse(await ingestPoints(store, series.name, body.points));
    },
    { fallbackMessage: "Failed to append points", onError: seriesErrorResponse },
  );

/**
 * Read a series' points in `[from, to)`
 *
 * `filter` takes `key:value` terms (`level:error speed:>30`), `where` the same
 * as a JSON predicate array; both are ANDed. Pages follow a cursor that names a
 * point, so paging stays stable across compaction.
 *
 * @tag Series
 * @jobToken
 * @param name Series name.
 * @query from!:integer Range start, ms, inclusive.
 * @query to!:integer Range end, ms, exclusive.
 * @query filter Terms like `level:error -host:a speed:>=30 msg:*timeout* id:*`.
 * @query where JSON-encoded predicate array.
 * @paginated
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const { store, series } = await requireSeriesAccess(context, Permission.VIEWER);
      const params = new URL(context.req.url).searchParams;
      const from = parseQueryInt(params, "from");
      const to = parseQueryInt(params, "to");
      const { limit, cursor } = parsePaginationParams(params, {
        defaultLimit: 1000,
        maxLimit: 10_000,
      });
      let where: unknown;
      try {
        where = JSON.parse(params.get("where") ?? "[]");
      } catch {
        throw new SeriesInputError("where must be JSON");
      }
      const page = await readSeriesPoints(store, series.name, {
        from,
        to,
        where: [
          ...parsePredicates(where),
          ...parseSeriesFilter(params.get("filter") ?? ""),
        ],
        limit,
        cursor,
      });
      return jsonResponse({ points: page.points, limit, nextCursor: page.nextCursor });
    },
    { fallbackMessage: "Failed to read points", onError: seriesErrorResponse },
  );
