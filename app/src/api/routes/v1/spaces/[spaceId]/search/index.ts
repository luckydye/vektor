import type { APIRoute } from "astro";
import {
  errorResponse,
  jsonResponse,
  parsePaginationParams,
  requireParam,
  withApiErrorHandling,
} from "#db/api.ts";
import { type PropertyFilter, searchDocuments } from "#db/documents.ts";
import { authenticateJobTokenOrSpaceRole } from "#utils/auth.ts";

export const GET: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      const spaceId = requireParam(context.params, "spaceId");

      // Resolve the identity used for per-document ACL filtering in
      // searchDocuments. For user sessions this is the user id; for access
      // tokens it is `token:<id>` so results are scoped to what the token can
      // actually read. Only trusted server-minted job tokens with no user
      // context (auth.userId === null) get the unfiltered, system-wide view.
      const auth = await authenticateJobTokenOrSpaceRole(context, spaceId, "viewer");
      const userId: string | null = auth.type === "user" ? auth.user.id : auth.userId;

      const query = context.url.searchParams.get("q") || "";
      const { limit, offset } = parsePaginationParams(context.url.searchParams, {
        defaultLimit: 20,
        maxLimit: 100,
      });
      const filtersParam = context.url.searchParams.get("filters");

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
        console.error(error);
        return errorResponse("Failed to search documents", 500);
      },
    },
  );
