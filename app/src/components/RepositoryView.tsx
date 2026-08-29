import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { isServer } from "solid-js/web";
import type { GitTreeEntry } from "#api/ApiClient.ts";
import { api } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import { useRoute } from "#composeables/useRoute.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { ensureLanguage, highlightToHtml, normalizeLanguage } from "#editor/prism.ts";
import { type GraphRow, layoutGraph } from "#git/graph.ts";
import { formatDateTime } from "#utils/dateFormat.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";
import { Icon } from "./Icon.tsx";
import { Tab, Tabs } from "./Tabs.tsx";

interface Props {
  documentId: string;
  spaceId: string;
}

/** What every request in this view needs to name a revision of a repository. */
interface RepoRef {
  spaceId: string;
  documentId: string;
  branch: string;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Prism's name for a file, from its extension — or from the whole name for the
 * files that carry their language there instead (`Dockerfile`, `Makefile`).
 */
function languageFor(path: string): string | null {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return normalizeLanguage(dot > 0 ? name.slice(dot + 1) : name);
}

/** Extensions a browser can draw; anything else stays a download. */
const VIEWABLE_IMAGES = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "svg",
  "ico",
]);

function isImage(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && VIEWABLE_IMAGES.has(name.slice(dot + 1).toLowerCase());
}

function isReadme(name: string): boolean {
  return /^readme(\.mdx?)?$/i.test(name);
}

/**
 * Copy `text`, falling back to a selection-based copy.
 *
 * `navigator.clipboard` rejects in more situations than are worth enumerating —
 * a denied permission, a window that does not have focus — and the older path
 * still works in those, because it runs inside the click that asked for it.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the selection-based path rather than failing silently.
  }

  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.top = "0";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

/**
 * The shape of a loaded tree, before it is known.
 *
 * Not a spinner in empty space: a listing arrives after a request that may have
 * to materialize a cache, and rendering nothing until then leaves the pane
 * collapsed and then jumps it open.
 */
function TreeSkeleton() {
  return (
    <div class="flex flex-col gap-2 p-2">
      <For each={[64, 46, 72, 54, 60, 40, 68, 50, 58, 44]}>
        {(width) => (
          <div class="flex items-center gap-2 px-1">
            <div class="size-3.5 shrink-0 rounded bg-neutral-500/10" />
            <div class="h-3 rounded bg-neutral-500/10" style={{ width: `${width}%` }} />
          </div>
        )}
      </For>
    </div>
  );
}

/** The views this document offers, in the order their tabs appear. */
const TABS = [
  { id: "files", label: "Files", icon: "file" },
  { id: "history", label: "History", icon: "activity" },
] as const;

/** Lane pitch and row height, shared by the layout and the drawing. */
const LANE = 14;
const ROW = 34;

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

interface LevelProps {
  repo: RepoRef;
  /** Directory this level lists; the empty string is the repository root. */
  path: string;
  depth: number;
  filter: string;
  expanded: () => Set<string>;
  onToggle: (path: string) => void;
  selected: () => string;
  onSelect: (entry: GitTreeEntry) => void;
}

/**
 * One directory of the tree, and the directories opened beneath it.
 *
 * Recursive rather than flattened, so a folder's children are only fetched once
 * it is opened — a deep repository costs one request per directory the reader
 * actually looks in.
 */
function TreeLevel(props: LevelProps) {
  const level = useQuery({
    queryKey: () => [
      "git",
      props.repo.spaceId,
      props.repo.documentId,
      "node",
      props.repo.branch,
      props.path,
    ],
    queryFn: async () => {
      const listing = await api.git
        .tree(props.repo.spaceId, props.repo.documentId, props.repo.branch, props.path)
        .catch(() => null);
      return listing?.entries ?? [];
    },
    enabled: () => !isServer && props.repo.branch !== "",
  });

  // The filter matches names at every level that is open. A folder survives it
  // while expanded, so a match found by digging does not vanish underneath.
  const visible = createMemo(() => {
    const entries = level.data() ?? [];
    const needle = props.filter.trim().toLowerCase();
    if (needle === "") return entries;
    return entries.filter(
      (entry) =>
        entry.name.toLowerCase().includes(needle) ||
        (entry.type === "tree" && props.expanded().has(entry.path)),
    );
  });

  return (
    <Show when={props.depth > 0 || level.data()} fallback={<TreeSkeleton />}>
      <For each={visible()}>
        {(entry) => (
          <>
            <button
              type="button"
              class="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-size-small hover:bg-neutral-500/10"
              classList={{ "bg-primary-100/60": props.selected() === entry.path }}
              style={{ "padding-left": `${props.depth * 14 + 8}px` }}
              onClick={() =>
                entry.type === "tree" ? props.onToggle(entry.path) : props.onSelect(entry)
              }
            >
              {/* A file has no chevron, but it keeps the slot so names line up
                  in one column whatever their kind. */}
              <Icon
                name={
                  entry.type === "tree" && props.expanded().has(entry.path)
                    ? "chevron-down"
                    : "chevron-right-small"
                }
                class={
                  entry.type === "tree"
                    ? "size-3.5 shrink-0 text-neutral-400"
                    : "size-3.5 shrink-0 opacity-0"
                }
              />
              <Icon
                name={entry.type === "tree" ? "folder" : "file"}
                class="size-4 shrink-0 text-neutral-400"
              />
              <span class="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>

            <Show when={entry.type === "tree" && props.expanded().has(entry.path)}>
              <TreeLevel {...props} path={entry.path} depth={props.depth + 1} />
            </Show>
          </>
        )}
      </For>
    </Show>
  );
}

/**
 * A repository document: its files, the commit that last touched them, and the
 * URL to clone it from.
 *
 * Reads go through the same document guard as anything else in the space, so
 * this shows exactly what a clone with the same credentials would.
 */
export function RepositoryView(props: Props) {
  const { currentSpace } = useSpace();
  const { documentSlug } = useRoute();
  const locale = useLocale();

  const [expanded, setExpanded] = createSignal(new Set<string>());
  const [selected, setSelected] = createSignal("");
  const [filter, setFilter] = createSignal("");
  // Open by default, and closed on a narrow window — decided in `onMount`
  // rather than at first render, so the server and the client agree on what
  // they drew.
  const [tab, setTab] = createSignal<(typeof TABS)[number]["id"]>("files");

  function onTabSelected(index: number) {
    const selected = TABS[index];
    if (selected) setTab(selected.id);
  }
  const [treeOpen, setTreeOpen] = createSignal(true);
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "failed">("idle");

  /**
   * Everything here goes through the shared query cache.
   *
   * The document body is unmounted and remounted while a page loads, which is
   * invisible for a view whose content came with the document — and very
   * visible for one that re-runs its requests and shows a skeleton until they
   * land. Cached by key, a remount paints the previous answer at once.
   *
   * None of it runs during server rendering either: reading a repository means
   * materializing its cache from object storage, which is not work a page load
   * should wait on.
   */
  const overview = useQuery({
    queryKey: () => ["git", props.spaceId, props.documentId, "overview"],
    queryFn: () => api.git.overview(props.spaceId, props.documentId),
    enabled: () => !isServer,
  });

  const repo = createMemo<RepoRef>(() => ({
    spaceId: props.spaceId,
    documentId: props.documentId,
    branch: overview.data()?.branch ?? "",
  }));

  /** The root listing, which also decides whether there is a README to open. */
  const root = useQuery({
    queryKey: () => ["git", props.spaceId, props.documentId, "node", repo().branch, ""],
    queryFn: async () => {
      const listing = await api.git
        .tree(props.spaceId, props.documentId, repo().branch, "")
        .catch(() => null);
      return listing?.entries ?? [];
    },
    enabled: () => !isServer && repo().branch !== "",
  });

  const readmeEntry = createMemo(() =>
    (root.data() ?? []).find((entry) => entry.type === "blob" && isReadme(entry.name)),
  );

  /** The file being read: whatever is selected, or the README by default. */
  const openPath = createMemo(() => selected() || (readmeEntry()?.path ?? ""));

  const content = useQuery({
    queryKey: () => [
      "git",
      props.spaceId,
      props.documentId,
      "blob",
      repo().branch,
      openPath(),
    ],
    queryFn: async () => {
      const path = openPath();
      if (path === "") return null;
      const blob = await api.git
        .blob(props.spaceId, props.documentId, repo().branch, path)
        .catch(() => null);
      if (!blob) return null;
      return {
        ...blob,
        html: blob.text && isReadme(path) ? renderMessageMarkdown(blob.text) : null,
      };
    },
    enabled: () => !isServer && repo().branch !== "" && openPath() !== "",
    // The file on screen stays while the next one loads, so picking a file never
    // empties the pane.
    placeholderData: (previous) => previous,
  });

  /**
   * The file's markup, once Prism has the grammar for it.
   *
   * Highlighting cannot be synchronous — grammars are loaded on demand — so the
   * pane renders plain text first and swaps in tokens when they arrive.
   */
  const [highlighted, setHighlighted] = createSignal<string | null>(null);
  createEffect(() => {
    const text = content.data()?.text ?? null;
    const language = languageFor(openPath());
    setHighlighted(null);
    if (!text || !language) return;

    void ensureLanguage(language).then(() => {
      // A larger file may still be loading; only the current one may paint.
      if (content.data()?.text !== text) return;
      setHighlighted(highlightToHtml(text, language));
    });
  });

  const history = useQuery({
    queryKey: () => ["git", props.spaceId, props.documentId, "log", repo().branch],
    queryFn: () => api.git.log(props.spaceId, props.documentId, repo().branch, 100),
    // Only asked for once the tab is open: a log is a separate walk of the
    // history, and the files view never needs it.
    enabled: () => !isServer && repo().branch !== "" && tab() === "history",
  });

  const graph = createMemo(() => {
    const commits = history.data()?.commits ?? [];
    return { commits, rows: layoutGraph(commits) };
  });

  /**
   * The bytes of the open file, straight from the API.
   *
   * An image is fetched by the browser rather than carried through JSON: the
   * endpoint sends it with its real content type and the same hardening
   * uploads get, so nothing here has to decode or re-encode it.
   */
  const rawUrl = createMemo(() => {
    const params = new URLSearchParams({
      view: "raw",
      rev: repo().branch,
      path: openPath(),
    });
    return `/api/v1/spaces/${props.spaceId}/documents/${props.documentId}/git?${params}`;
  });

  // A memo rather than a plain function: `documentSlug()` reads router
  // primitives, which throw outside a tracking context — and the copy handler
  // is exactly that. The origin is a signal because there is no window during
  // server rendering, and a memo over a direct read would cache that emptiness.
  const [origin, setOrigin] = createSignal("");
  onMount(() => setOrigin(window.location.origin));
  const cloneUrl = createMemo(
    () => `${origin()}/${currentSpace()?.slug}/git/${documentSlug()}.git`,
  );

  async function copyCloneUrl() {
    setCopyState((await copyText(cloneUrl())) ? "copied" : "failed");
    setTimeout(() => setCopyState("idle"), 2000);
  }

  /**
   * The height that reaches from the panes down to the bottom of the viewport.
   *
   * `position: sticky` cannot do this: an ancestor of the document body has
   * `overflow-x: auto`, which makes that element the scrollport a sticky child
   * would stick to — while the document is what actually scrolls. Sizing the
   * panes to the viewport instead lets each of them scroll on its own, so the
   * tree stays put however long the file beside it is.
   */
  let panes: HTMLDivElement | undefined;
  const [panesHeight, setPanesHeight] = createSignal("32rem");
  onMount(() => {
    const update = () => {
      if (!panes) return;
      const top = panes.getBoundingClientRect().top;
      // Leaves room for the page's own bottom padding, so a view that already
      // reaches the fold does not add a scrollbar for empty space.
      setPanesHeight(`${Math.max(320, window.innerHeight - top - 42)}px`);
    };
    update();
    if (window.innerWidth < 768) setTreeOpen(false);
    window.addEventListener("resize", update);
    onCleanup(() => window.removeEventListener("resize", update));
  });

  function toggle(path: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  }

  return (
    // No card around this and no repository name: the document page already
    // draws both, and repeating them boxes the view inside a page that is
    // itself the box.
    <div class="flex w-full min-w-0 flex-col">
      {/* Clear of the properties above, and clear of the tabs below: this line
          belongs to neither. */}
      <div class="mt-4xs mb-2xs flex flex-col gap-2">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-2 text-neutral-500 text-size-small">
          <span class="rounded-md bg-neutral-500/10 px-1.5 py-0.5 text-size-extra-small">
            {overview.data()?.branch ?? "main"}
          </span>
          <Show when={overview.data()?.head}>
            {(head) => (
              <>
                <code class="rounded-md bg-neutral-500/10 px-1.5 py-0.5 font-mono">
                  {head().shortOid}
                </code>
                <span class="truncate text-foreground">{head().subject}</span>
                <span>· {head().author}</span>
                <span>· {formatDateTime(head().authoredAt, locale)}</span>
              </>
            )}
          </Show>

          {/* One control rather than a field with a button inside it: nesting
              two focusable boxes gives two borders and two focus rings. */}
          <button
            type="button"
            class="group ml-auto flex min-w-0 items-center gap-2 rounded-md border border-neutral-500/15 py-1 pr-2 pl-2.5 transition-colors hover:bg-neutral-500/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
            title={
              copyState() === "failed"
                ? "Could not copy — select the URL and copy it"
                : "Copy clone URL"
            }
            aria-label="Copy clone URL"
            onClick={copyCloneUrl}
          >
            <code class="min-w-0 max-w-[22rem] truncate font-mono text-neutral-500 text-size-small">
              {cloneUrl()}
            </code>
            {/* A fixed box: these icons have different intrinsic sizes, and
                without it the button resizes as the state changes. */}
            <Icon
              name={
                copyState() === "copied"
                  ? "confirmation"
                  : copyState() === "failed"
                    ? "warning-triangle"
                    : "copy"
              }
              class={
                copyState() === "failed"
                  ? "size-4 shrink-0 text-red-600"
                  : "size-4 shrink-0 text-neutral-400 group-hover:text-foreground"
              }
            />
          </button>
        </div>
      </div>

      <Show
        when={!overview.data()?.empty}
        fallback={
          <div class="flex flex-col items-center gap-1 py-16">
            <p class="font-medium text-size-medium">Nothing pushed yet</p>
            <p class="text-neutral-500 text-size-small">
              Push a branch to this URL and its files appear here.
            </p>
          </div>
        }
      >
        {/* The app's own tabs element, so selection, keyboard handling and the
            pill styling are the ones used everywhere else. */}
        <Tabs class="mb-4xs" onSelect={onTabSelected}>
          <For each={TABS}>
            {(view, index) => (
              <Tab selected={index() === 0} icon={view.icon}>
                {view.label}
              </Tab>
            )}
          </For>
        </Tabs>

        <div
          ref={panes}
          class="flex items-stretch overflow-hidden rounded-lg border border-neutral-500/15"
          classList={{ hidden: tab() !== "files" }}
          style={{ height: panesHeight() }}
        >
          <Show when={treeOpen()}>
            {/* Ordered rather than reordered: the tree sits to the right of
                the file, but stays first in the DOM so a reader meets the
                navigation before the thing it navigates. */}
            <div class="order-2 flex w-64 shrink-0 flex-col border-neutral-500/15 border-l">
              <div class="flex h-11 shrink-0 items-center border-neutral-500/15 border-b px-2">
                <input
                  type="search"
                  class="focus-ring w-full rounded-md border border-neutral-500/15 bg-transparent px-2 py-1 text-size-small"
                  placeholder="Filter files…"
                  value={filter()}
                  onInput={(event) => setFilter(event.currentTarget.value)}
                />
              </div>
              <div class="flex-1 overflow-y-auto p-1">
                <TreeLevel
                  repo={repo()}
                  path=""
                  depth={0}
                  filter={filter()}
                  expanded={expanded}
                  onToggle={toggle}
                  selected={selected}
                  onSelect={(entry) => setSelected(entry.path)}
                />
              </div>
            </div>
          </Show>

          <div class="order-1 flex min-w-0 flex-1 flex-col">
            <div class="flex h-11 shrink-0 items-center gap-2 border-neutral-500/15 border-b px-3 text-size-small">
              <span class="truncate text-neutral-500">
                {openPath() || documentSlug()}
              </span>
              <button
                type="button"
                class="focus-ring ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-500/10 hover:text-foreground"
                onClick={() => setTreeOpen(!treeOpen())}
              >
                <Icon name="collapse-sidebar" class="size-4" />
                {treeOpen() ? "Collapse tree" : "Show tree"}
              </button>
            </div>

            <Show
              when={content.data()}
              fallback={
                <p class="px-4 py-16 text-center text-neutral-500 text-size-small">
                  Select a file to read it.
                </p>
              }
            >
              {(blob) => (
                <div class="min-w-0 flex-1 overflow-auto">
                  <Show
                    when={blob().text !== null}
                    fallback={
                      <Show
                        when={isImage(openPath())}
                        fallback={
                          <p class="px-4 py-16 text-center text-neutral-500 text-size-small">
                            {formatSize(blob().size)} — not text, or too large to show.
                            Clone the repository to read it.
                          </p>
                        }
                      >
                        <div class="flex items-center justify-center p-6">
                          <img
                            src={rawUrl()}
                            alt={openPath()}
                            // Checkered behind it, so a transparent image reads
                            // as transparent rather than as white.
                            class="max-h-full max-w-full rounded border border-neutral-500/15 bg-[length:16px_16px] bg-[repeating-conic-gradient(theme(colors.neutral.500/10)_0_25%,transparent_0_50%)] object-contain"
                          />
                        </div>
                      </Show>
                    }
                  >
                    <Show
                      when={blob().html}
                      fallback={
                        <pre class="overflow-x-auto px-4 py-3 font-mono text-size-small leading-relaxed">
                          <Show
                            when={highlighted()}
                            fallback={<code>{blob().text}</code>}
                          >
                            {/* Prism's own token spans, over text this view
                                fetched — not markup from the repository. */}
                            {(html) => <code innerHTML={html()} />}
                          </Show>
                        </pre>
                      }
                    >
                      {(html) => (
                        // Sanitized by `renderMessageMarkdown`: a README is
                        // untrusted content from whoever pushed it.
                        <div
                          class="markdown-content readme-content px-4 py-3"
                          innerHTML={html()}
                        />
                      )}
                    </Show>
                  </Show>
                </div>
              )}
            </Show>
          </div>
        </div>

        <Show when={tab() === "history"}>
          <div
            class="overflow-auto rounded-lg border border-neutral-500/15"
            style={{ height: panesHeight() }}
          >
            <For
              each={graph().commits}
              fallback={
                <p class="px-3 py-16 text-center text-neutral-500 text-size-small">
                  Loading history…
                </p>
              }
            >
              {(commit, index) => (
                <div class="flex items-center gap-3 border-neutral-500/10 border-b px-3 text-size-small last:border-b-0 hover:bg-neutral-500/5">
                  <GraphCell row={graph().rows[index()]} />
                  <code class="shrink-0 font-mono text-neutral-500">
                    {commit.shortOid}
                  </code>
                  <span class="min-w-0 flex-1 truncate">{commit.subject}</span>
                  <span class="shrink-0 text-neutral-500">{commit.author}</span>
                  <span class="shrink-0 text-neutral-400">
                    {formatDateTime(commit.authoredAt, locale)}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Show>
    </div>
  );
}
