import type { ApiRouteHandler } from "#api/server/types.ts";
import {
  errorResponse,
  jsonResponse,
  parsePaginationParams,
  requireParam,
  withApiErrorHandling,
} from "#db/api.ts";
import { type PropertyFilter, searchDocuments } from "#db/search.ts";
import { appLogger } from "#observability/logger.ts";
import { authenticateSpaceAccess } from "#utils/auth.ts";

export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.var.params, "spaceId");

      const access = await authenticateSpaceAccess(context, spaceId, "viewer");
      // searchDocuments uses null for "trusted system view" (no per-document
      // ACL filtering). Public access is treated as trusted within the space
      // so documents inheriting space-level access are searchable.
      const userId = access.isPublic ? null : access.aclUserId;

      const query = new URL(context.req.url).searchParams.get("q") || "";
      const { limit, offset } = parsePaginationParams(
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
        return jsonResponse({ results: [], total: 0, query: "", filters: [] });
      }

      const { results, total } = await searchDocuments(
        spaceId,
        userId,
        query,
        limit,
        offset,
        filters,
      );

      return jsonResponse({
        results,
        total,
        query,
        limit,
        offset,
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
