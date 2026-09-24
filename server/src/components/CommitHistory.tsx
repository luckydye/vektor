import { createMemo, For, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { api } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { type GraphRow, layoutGraph } from "#git/graph.ts";
import { formatDateTime } from "#utils/dateFormat.ts";

interface Props {
  spaceId: string;
  documentId: string;
}

/** Lane pitch and row height, shared by the layout and the drawing. */
const LANE = 14;
const ROW = 46;

function laneX(lane: number): number {
  return lane * LANE + LANE / 2;
}

/**
 * One row of the commit graph.
 *
 * Every edge is drawn as a full-height curve from the lane it enters at to the
 * lane it leaves at, so a straight lane is a straight line and a branch or a
 * merge bends once. The dot marks the commit's own lane.
 */
function GraphCell(props: { row: GraphRow }) {
  return (
    <svg
      class="shrink-0 text-neutral-400"
      width={props.row.width * LANE}
      height={ROW}
      aria-hidden="true"
    >
      <For each={props.row.edges}>
        {(edge) => (
          <path
            d={
              edge.from === edge.to
                ? `M ${laneX(edge.from)} 0 V ${ROW}`
                : `M ${laneX(edge.from)} 0 C ${laneX(edge.from)} ${ROW / 2}, ${laneX(edge.to)} ${ROW / 2}, ${laneX(edge.to)} ${ROW}`
            }
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
          />
        )}
      </For>
      <circle
        cx={laneX(props.row.lane)}
        cy={ROW / 2}
        r="4"
        class="fill-primary-400 stroke-background"
        stroke-width="2"
      />
    </svg>
  );
}

/**
 * The commit log of a repository document, drawn as a graph.
 *
 * Two lines per commit rather than one, because this lives in the activity
 * panel, where a single row has no space for subject, author and date at once.
 */
export function CommitHistory(props: Props) {
  const locale = useLocale();

  const overview = useQuery({
    queryKey: () => ["git", props.spaceId, props.documentId, "overview"],
    queryFn: () => api.git.overview(props.spaceId, props.documentId),
    enabled: () => !isServer,
  });

  const branch = createMemo(() => overview.data()?.branch ?? "");

  const history = useQuery({
    queryKey: () => ["git", props.spaceId, props.documentId, "log", branch()],
    queryFn: () => api.git.log(props.spaceId, props.documentId, branch(), 100),
    enabled: () => !isServer && branch() !== "",
  });

  const graph = createMemo(() => {
    const commits = history.data()?.commits ?? [];
    return { commits, rows: layoutGraph(commits) };
  });

  return (
    <Show
      when={graph().commits.length > 0}
      fallback={
        <p class="px-3 py-16 text-center text-neutral-500 text-size-small">
          <Show when={!history.isLoading()} fallback="Loading history…">
            No commits yet
          </Show>
        </p>
      }
    >
      <For each={graph().commits}>
        {(commit, index) => (
          <div class="flex items-center gap-2 border-neutral-500/10 border-b px-3 last:border-b-0 hover:bg-neutral-500/5">
            <GraphCell row={graph().rows[index()]} />
            <div class="min-w-0 flex-1 py-1.5">
              <p class="truncate text-size-small">{commit.subject}</p>
              <p class="flex items-center gap-1.5 text-neutral-500 text-size-extra-small">
                <code class="font-mono">{commit.shortOid}</code>
                <span class="truncate">{commit.author}</span>
                <span class="shrink-0 text-neutral-400">
                  {formatDateTime(commit.authoredAt, locale)}
                </span>
              </p>
            </div>
          </div>
        )}
      </For>
    </Show>
  );
}
