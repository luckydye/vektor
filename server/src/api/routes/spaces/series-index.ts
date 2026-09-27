import { Permission, ResourceType } from "#acl/permissions.ts";
import { filterReadableResources } from "#acl/store.ts";
import { getUserGroups } from "#acl/userGroups.ts";
import {
  badRequestResponse,
  jsonResponse,
  parseJsonBody,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { declareSeries, listSeries, type SeriesKind } from "#series/catalog.ts";
import {
  authenticateSeriesRole,
  publicSeries,
  seriesErrorResponse,
} from "./seriesAccess.ts";

/**
 * List the space's time series
 *
 * @tag Series
 * @jobToken
 * @note Series owned by a document the caller cannot read are left out.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(async () => {
    const spaceId = requireParam(context.var.params, "spaceId");
    const aclUserId = await authenticateSeriesRole(
      context,
      spaceId,
      Permission.VIEWER,
      null,
    );
    const rows = await listSeries(await openSpaceStore(spaceId));
    const documentIds = rows.flatMap((row) => (row.documentId ? [row.documentId] : []));
    const readable = aclUserId
      ? await filterReadableResources(spaceId, ResourceType.DOCUMENT, documentIds, {
          userId: aclUserId,
          userGroups: await getUserGroups(aclUserId),
        })
      : new Set(documentIds);
    return jsonResponse({
      series: rows
        .filter((row) => !row.documentId || readable.has(row.documentId))
        .map(publicSeries),
    });
  }, "Failed to list series");

/**
 * Declare a time series
 *
 * Idempotent: declaring an existing series with the same kind, document and
 * window returns it; anything else conflicts.
 *
 * @tag Series
 * @jobToken
 * @body
 */
export const POST: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");
      const body = await parseJsonBody<{
        name?: unknown;
        kind?: unknown;
        documentId?: unknown;
        windowSeconds?: number;
        retentionDays?: number | null;
        compactAfterSegments?: number;
      }>(context.req.raw);
      if (typeof body.name !== "string" || typeof body.kind !== "string") {
        return badRequestResponse("name and kind are required");
      }
      if (body.documentId !== undefined && typeof body.documentId !== "string") {
        return badRequestResponse("documentId must be a string");
      }
      const documentId = body.documentId ?? null;
      const aclUserId = await authenticateSeriesRole(
        context,
        spaceId,
        Permission.EDITOR,
        documentId,
      );
      const { series, created } = await declareSeries(await openSpaceStore(spaceId), {
        name: body.name,
        kind: body.kind as SeriesKind,
        documentId,
        windowSeconds: body.windowSeconds,
        retentionDays: body.retentionDays,
        compactAfterSegments: body.compactAfterSegments,
        createdBy: aclUserId ?? "system",
      });
      return jsonResponse({ series: publicSeries(series) }, created ? 201 : 200);
    },
    { fallbackMessage: "Failed to declare series", onError: seriesErrorResponse },
  );
