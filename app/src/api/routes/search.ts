import {
  errorResponse,
  jsonResponse,
  parseSearchFilters,
  withApiErrorHandling,
} from "#api/http.ts";
import type { ApiRouteHandler } from "#api/server/types.ts";
import { appLogger } from "#observability/logger.ts";
import { searchOtherSpaces } from "#search/crossSpace.ts";

/**
 * Search beyond one space: the strongest matches in the other spaces the caller
 * can read. `excludeSpaceId` is the space they are searching in, whose own
 * results come from `/spaces/[spaceId]/search` — paged, and ranked as usual.
 */
export const GET: ApiRouteHandler = (context) =>
  withApiErrorHandling(
    async () => {
      const searchParams = new URL(context.req.url).searchParams;
      const query = searchParams.get("q") || "";
      const filters = parseSearchFilters(searchParams.get("filters"));

      // Other spaces are the user's own reach, so this needs a session: a
      // space-scoped access token and a public visitor have none to widen to.
      const user = context.var.user;
      if (!user || !query.trim()) {
        return jsonResponse({ results: [], query });
      }

      return jsonResponse({
        results: await searchOtherSpaces(user.id, query, {
          excludeSpaceId: searchParams.get("excludeSpaceId") ?? undefined,
          filters,
        }),
        query,
      });
    },
    {
      fallbackMessage: "Failed to search spaces",
      onError: (error) => {
        appLogger.error("Cross-space search request failed", { error });
        return errorResponse("Failed to search spaces", 500);
      },
    },
  );
