import { Permission } from "#acl/permissions.ts";
import {
  jsonResponse,
  parseJsonBody,
  successResponse,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { deleteSeries, patchSeries } from "#series/catalog.ts";
import { SeriesInputError } from "#series/limits.ts";
import { latestPointWithin } from "#series/store.ts";
import {
  publicSeries,
  requireSeriesAccess,
  seriesErrorResponse,
} from "./seriesAccess.ts";

/** How many windows back "last seen" looks. */
const LATEST_POINT_WINDOWS = 24;

/**
 * Read one time series, with its latest point
 *
 * @tag Series
 * @jobToken
 * @param name Series name.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const { store, series } = await requireSeriesAccess(context, Permission.VIEWER);
      return jsonResponse({
        series: publicSeries(series),
        latestPoint: await latestPointWithin(store, series.name, LATEST_POINT_WINDOWS),
      });
    },
    { fallbackMessage: "Failed to read series", onError: seriesErrorResponse },
  );

/**
 * Change a series' retention or compaction threshold
 *
 * @tag Series
 * @jobToken
 * @body
 * @note `windowSeconds` is fixed at declaration: every stored key depends on it.
 */
export const PATCH: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const { store, series } = await requireSeriesAccess(context, Permission.EDITOR);
      const body = await parseJsonBody<Record<string, unknown>>(context.req.raw);
      if ("windowSeconds" in body) {
        throw new SeriesInputError("windowSeconds cannot change after declaration");
      }
      const updated = await patchSeries(store, series.name, {
        retentionDays: body.retentionDays as number | null | undefined,
        compactAfterSegments: body.compactAfterSegments as number | undefined,
      });
      return jsonResponse({ series: publicSeries(updated) });
    },
    { fallbackMessage: "Failed to update series", onError: seriesErrorResponse },
  );

/**
 * Delete a series and every point it holds
 *
 * @tag Series
 * @jobToken
 */
export const DELETE: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const { store, series } = await requireSeriesAccess(context, Permission.EDITOR);
      await deleteSeries(store, series.name);
      return successResponse();
    },
    { fallbackMessage: "Failed to delete series", onError: seriesErrorResponse },
  );
