import { authenticateSpaceAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { listAccessibleResources } from "#acl/store.ts";
import {
  errorResponse,
  jsonResponse,
  parsePaginationParams,
  requireParam,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { type PropertyFilter, searchDocuments } from "#db/space/search.ts";
import { appLogger } from "#observability/logger.ts";
import { refreshStaleDocumentIndexes } from "#search/indexing.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");

      const access = await authenticateSpaceAccess(context, spaceId, Permission.VIEWER);
      // null means "no per-document filtering". Public access is trusted within
      // the space, so documents inheriting space-level access are searchable.
      const userId = access.isPublic ? null : access.aclUserId;

      const query = new URL(context.req.url).searchParams.get("q") || "";
      const { limit, cursor } = parsePaginationParams(
        new URL(context.req.url).searchParams,
        {
          defaultLimit: 20,
          maxLimit: 100,
        },
      );
      const filtersParam = new URL(context.req.url).searchParams.get("filters");

      // Parse property filters from JSON string
      let filters: PropertyFilter[] = [];
      if (filtersParam) {
        try {
          const parsed = JSON.parse(filtersParam);
          if (!Array.isArray(parsed)) {
            throw new Error("Filters must be an array");
          }
          for (const filter of parsed) {
            if (typeof filter.key !== "string" || !filter.key.trim()) {
              throw new Error("Each filter must have a non-empty 'key' string");
            }
            if (filter.value !== null && typeof filter.value !== "string") {
              throw new Error("Filter 'value' must be a string or null");
            }
          }
          filters = parsed;
        } catch (e) {
          throw new Response(
            `Invalid filters parameter: ${e instanceof Error ? e.message : "Parse error"}`,
            { status: 400 },
          );
        }
      }

      // Allow empty query only when filters are provided
      if (!query.trim() && filters.length === 0) {
        return jsonResponse({ results: [], nextCursor: null, query: "", filters: [] });
      }

      const store = await openSpaceStore(spaceId);
      const docIds =
        userId === null
          ? null
          : await listAccessibleResources(spaceId, userId, ResourceType.DOCUMENT);

      // Catch up stale indexes before the query reads them — but not for a
      // caller who can read nothing, since the search returns empty regardless.
      if (query.trim() && docIds?.length !== 0) {
        await refreshStaleDocumentIndexes(store);
      }

      const { results, nextCursor } = await searchDocuments(
        store,
        docIds,
        query,
        limit,
        cursor,
        filters,
      );

      return jsonResponse({
        results,
        nextCursor,
        query,
        limit,
        filters,
      });
    },
    {
      fallbackMessage: "Failed to search documents",
      onError: (error) => {
        appLogger.error("Search request failed", { error });
        return errorResponse("Failed to search documents", 500);
      },
    },
  );
