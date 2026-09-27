import { authenticateJobTokenOrSpaceRole, requireSpace } from "#acl/guards.ts";
import { type Permission, ResourceType } from "#acl/permissions.ts";
import { errorResponse, notFoundResponse, requireParam } from "#api/http.ts";
import type { ApiContext } from "#api/server/types.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import type { SeriesRow } from "#db/schema/space.ts";
import { getSeries } from "#series/catalog.ts";
import { SeriesInputError } from "#series/limits.ts";

export interface SeriesAccess {
  spaceId: string;
  store: SpaceStore;
  series: SeriesRow;
  /** The caller in the ACL-user convention: null is a trusted system caller. */
  aclUserId: string | null;
}

/** Authenticate `role` on whatever owns the series: its document, else the space. */
export async function authenticateSeriesRole(
  context: ApiContext,
  spaceId: string,
  role: Permission,
  documentId: string | null,
): Promise<string | null> {
  const auth = await authenticateJobTokenOrSpaceRole(
    context.var.credentials,
    spaceId,
    role,
    documentId ? { type: ResourceType.DOCUMENT, id: documentId } : undefined,
  );
  return auth.type === "user" ? auth.user.id : auth.userId;
}

/**
 * The series named in the route, once the caller holds `role` on it. A missing
 * series is checked against the space first, so its absence leaks nothing.
 */
export async function requireSeriesAccess(
  context: ApiContext,
  role: Permission,
): Promise<SeriesAccess> {
  const spaceId = requireParam(context.var.params, "spaceId");
  const name = requireParam(context.var.params, "name");
  await requireSpace(spaceId);
  const store = await openSpaceStore(spaceId);
  const series = await getSeries(store, name);
  const aclUserId = await authenticateSeriesRole(
    context,
    spaceId,
    role,
    series?.documentId ?? null,
  );
  if (!series) throw notFoundResponse("Series");
  return { spaceId, store, series, aclUserId };
}

export function seriesErrorResponse(error: unknown): Response | undefined {
  if (error instanceof SeriesInputError)
    return errorResponse(error.message, error.status);
  return undefined;
}

export function publicSeries(series: SeriesRow) {
  return {
    id: series.id,
    name: series.name,
    kind: series.kind,
    documentId: series.documentId,
    windowSeconds: series.windowSeconds,
    retentionDays: series.retentionDays,
    compactAfterSegments: series.compactAfterSegments,
    pointCount: series.pointCount,
    byteCount: series.byteCount,
    createdAt: series.createdAt.toISOString(),
    updatedAt: series.updatedAt.toISOString(),
    createdBy: series.createdBy,
  };
}
