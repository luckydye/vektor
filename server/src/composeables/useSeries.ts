import { type Accessor, createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import type { SeriesPoint } from "#series/format.ts";
import type { SeriesPredicate } from "#series/predicates.ts";
import type { SeriesQuery } from "#series/query.ts";
import { useQuery } from "./query.ts";
import { useSync } from "./useSync.ts";

/** How far past the present an open-ended read reaches, for clock skew. */
const OPEN_END_MS = 60_000;

interface SeriesPointsOptions {
  spaceId: Accessor<string | null | undefined>;
  name: Accessor<string | null | undefined>;
  from: Accessor<number>;
  /** Omitted, the range stays open and every refetch reads up to the present. */
  to?: Accessor<number>;
  where?: Accessor<SeriesPredicate[]>;
}

/**
 * Every point of a series in a range, refetched whenever the series is appended
 * to. Points stay out of the replica: they are only ever read from the API.
 */
export function useSeriesPoints(options: SeriesPointsOptions) {
  const enabled = createMemo(() => !!options.spaceId() && !!options.name());
  const { data, isPending, error, refetch } = useQuery({
    queryKey: createMemo(() => [
      "series_points",
      options.spaceId(),
      options.name(),
      options.from(),
      options.to?.() ?? null,
      JSON.stringify(options.where?.() ?? []),
    ]),
    queryFn: async () => {
      const spaceId = options.spaceId() as string;
      const name = options.name() as string;
      const query = {
        from: options.from(),
        to: options.to ? options.to() : Date.now() + OPEN_END_MS,
        where: options.where?.(),
        limit: 10_000,
      };
      const points: SeriesPoint[] = [];
      let cursor: string | undefined;
      do {
        const page = await api.series.points(spaceId, name, { ...query, cursor });
        points.push(...page.points);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return points;
    },
    enabled,
  });

  useSync(
    () => options.spaceId() ?? null,
    () => {
      const name = options.name();
      return name ? [realtimeTopics.series(name)] : [];
    },
    () => void refetch(),
  );

  return { points: createMemo(() => data() ?? []), isLoading: isPending, error, refetch };
}

/** A stored query over a series, rerun whenever the series is appended to. */
export function useSeriesQuery(options: {
  spaceId: Accessor<string | null | undefined>;
  name: Accessor<string | null | undefined>;
  query: Accessor<SeriesQuery>;
}) {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: createMemo(() => [
      "series_query",
      options.spaceId(),
      options.name(),
      JSON.stringify(options.query()),
    ]),
    queryFn: () =>
      api.series.query(
        options.spaceId() as string,
        options.name() as string,
        options.query(),
      ),
    enabled: createMemo(() => !!options.spaceId() && !!options.name()),
  });

  useSync(
    () => options.spaceId() ?? null,
    () => {
      const name = options.name();
      return name ? [realtimeTopics.series(name)] : [];
    },
    () => void refetch(),
  );

  return { result: data, isLoading: isPending, error, refetch };
}
