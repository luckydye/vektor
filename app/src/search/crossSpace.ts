/**
 * Searching the spaces around the one the user is in. Every space is its own
 * database, so this fans out over them and merges what comes back; the bar a
 * foreign hit has to clear is `RankingOptions.strict` in `#search/ranking.ts`.
 */

import { canView } from "#acl/permissions.ts";
import { openSpaceStore } from "#db/client/store.ts";
import {
  type PropertyFilter,
  type SearchResult,
  searchDocuments,
} from "#db/space/search.ts";
import { listUserSpaces, type Space } from "#db/space/spaces.ts";
import { appLogger } from "#observability/logger.ts";
import { embedSearchQuery } from "#search/embedding.ts";

/** A hint that matches exist elsewhere, not a second result list. */
const MAX_RESULTS = 5;
/** Per space, so that one space cannot crowd the others out of that hint. */
const MAX_PER_SPACE = 2;
/** Spaces searched at once: each is a scan of that space's documents. */
const SPACE_CONCURRENCY = 4;

export type CrossSpaceSearchResult = SearchResult & {
  spaceId: string;
  spaceName: string;
  spaceSlug: string;
};

export interface CrossSpaceSearchOptions {
  /** The space the user is searching in, whose own results are shown already. */
  excludeSpaceId?: string;
  filters?: PropertyFilter[];
}

async function searchSpace(
  space: Space,
  query: string,
  queryEmbedding: number[] | null,
  filters: PropertyFilter[],
): Promise<CrossSpaceSearchResult[]> {
  const store = await openSpaceStore(space.id);
  // No stale-index catch-up: embedding another space's documents is work the
  // searcher did not ask for, and writes there refresh their own index anyway.
  const { results } = await searchDocuments(store, null, query, {
    limit: MAX_PER_SPACE,
    filters,
    strict: true,
    queryEmbedding,
  });

  // No branding here: the client already holds every space it can reach, logo and
  // colour included, so repeating those per result would be a second copy to keep
  // in step.
  return results.map((result) => ({
    ...result,
    spaceId: space.id,
    spaceName: space.name,
    spaceSlug: space.slug,
  }));
}

/**
 * The best matches for `query` across every other space `userId` can read,
 * ranked against each other. Needs a real query: with filters alone there is
 * nothing to rank a foreign document by, and every space would answer with its
 * newest documents.
 */
export async function searchOtherSpaces(
  userId: string,
  query: string,
  options: CrossSpaceSearchOptions = {},
): Promise<CrossSpaceSearchResult[]> {
  if (!query.trim()) return [];

  // A space-wide viewer role, as the space's own search endpoint demands: a
  // grant on single documents elsewhere is not a licence to search that space.
  const spaces = (await listUserSpaces(userId)).filter(
    (space) => space.id !== options.excludeSpaceId && canView(space.userRole),
  );
  if (spaces.length === 0) return [];

  // One vector for every space, and embedding is native compute.
  const queryEmbedding = await embedSearchQuery(query);

  const found: CrossSpaceSearchResult[] = [];
  let nextSpace = 0;

  const searchNextSpace = async (): Promise<void> => {
    while (nextSpace < spaces.length) {
      const space = spaces[nextSpace++];
      try {
        found.push(
          ...(await searchSpace(space, query, queryEmbedding, options.filters ?? [])),
        );
      } catch (error) {
        // One unreachable space must not take the whole search down with it.
        appLogger.warn("Cross-space search skipped a space", {
          error,
          spaceId: space.id,
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(SPACE_CONCURRENCY, spaces.length) }, searchNextSpace),
  );

  return found.sort((left, right) => left.rank - right.rank).slice(0, MAX_RESULTS);
}
