import { Permission } from "#acl/permissions.ts";
import { jsonResponse, parseJsonBody, withApiErrorHandling } from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { parseSeriesQuery, querySeries } from "#series/query.ts";
import { requireSeriesAccess, seriesErrorResponse } from "./seriesAccess.ts";

/**
 * Aggregate a series
 *
 * Buckets `[from, to)` by `every` ms and optionally `groupBy` a column. The
 * response reports what was scanned and what header statistics pruned.
 *
 * @tag Series
 * @jobToken
 * @param name Series name.
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const { store, series } = await requireSeriesAccess(context, Permission.VIEWER);
      const query = parseSeriesQuery(await parseJsonBody(context.req.raw));
      return jsonResponse(await querySeries(store, series.name, query));
    },
    { fallbackMessage: "Failed to query series", onError: seriesErrorResponse },
  );
