import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import type { GitTreeEntry } from "#api/ApiClient.ts";
import { api } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import { useRoute } from "#composeables/useRoute.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { formatDateTime } from "#utils/dateFormat.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";
import { Icon } from "./Icon.tsx";

interface Props {
  documentId: string;
  spaceId: string;
}

function formatSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

/** The path segments above `path`, so each one can be navigated back to. */
function crumbs(path: string): { name: string; path: string }[] {
  if (path === "") return [];
  const parts = path.split("/");
  return parts.map((name, index) => ({
    name,
    path: parts.slice(0, index + 1).join("/"),
  }));
}

/**
 * The shape of a loaded repository, before it is known.
 *
 * Not a spinner in empty space: the listing arrives after a request that may
 * have to materialize a cache, and a view rendering nothing until then leaves
 * the page collapsed and then jumps it open. Holding the shape costs nothing
 * and removes the reflow.
 */
function Skeleton() {
  return (
    <div class="overflow-hidden rounded-lg border border-neutral-500/15">
      <div class="h-9 border-neutral-500/15 border-b bg-neutral-500/5" />
      <For each={[38, 22, 30, 46, 26, 34, 42, 28, 36, 24]}>
        {(width) => (
          <div class="flex items-center gap-2.5 border-neutral-500/10 border-b px-3 py-1.5 last:border-b-0">
            <div class="size-4 shrink-0 rounded bg-neutral-500/10" />
            {/* Varied widths so this reads as a list of names rather than a
                stack of identical bars. */}
            <div class="h-3 rounded bg-neutral-500/10" style={{ width: `${width}%` }} />
          </div>
        )}
      </For>
    </div>
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
  // The path being viewed. Empty is the repository root; a blob path shows the
  // file rather than a listing.
  const [path, setPath] = createSignal("");
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "failed">("idle");

  /**
   * Everything here goes through the shared query cache.
   *
   * The document body is unmounted and remounted while a page loads, which is
   * invisible for a view whose content came with the document — and very
   * visible for one that re-runs three requests and renders a skeleton until
   * they land. Cached by key, a remount paints the previous answer at once.
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

  /** The branch a browse follows, once the summary says which one it is. */
  const branch = () => overview.data()?.branch ?? "";

  /**
   * What is at `path`: a listing, or a file.
   *
   * One query rather than two, because a path is only known to be a file once
   * the tree request for it comes back empty.
   */
  const node = useQuery({
    queryKey: () => ["git", props.spaceId, props.documentId, "node", branch(), path()],
    queryFn: async () => {
      const listing = await api.git
        .tree(props.spaceId, props.documentId, branch(), path())
        .catch(() => null);
      if (listing) return { kind: "tree" as const, entries: listing.entries };

      const blob = await api.git
        .blob(props.spaceId, props.documentId, branch(), path())
        .catch(() => null);
      return blob ? { kind: "blob" as const, ...blob } : null;
    },
    enabled: () => !isServer && branch() !== "",
    // The previous listing stays on screen while the next one loads, so
    // navigating into a folder never empties the box.
    placeholderData: (previous) => previous,
  });

  const entries = () => {
    const current = node.data();
    return current?.kind === "tree" ? current.entries : null;
  };
  const file = () => {
    const current = node.data();
    return current?.kind === "blob" ? current : null;
  };

  const readmeEntry = createMemo(() =>
    entries()?.find(
      (entry) => entry.type === "blob" && /^readme(\.mdx?)?$/i.test(entry.name),
    ),
  );

  const readme = useQuery({
    queryKey: () => [
      "git",
      props.spaceId,
      props.documentId,
      "readme",
      branch(),
      readmeEntry()?.path ?? "",
    ],
    queryFn: async () => {
      const entry = readmeEntry();
      if (!entry) return null;
      const result = await api.git
        .blob(props.spaceId, props.documentId, branch(), entry.path)
        .catch(() => null);
      return result?.text ? renderMessageMarkdown(result.text) : null;
    },
    enabled: () => !isServer && !!readmeEntry(),
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

  // No width cap here: the document page already decides how wide a document
  // is, and Tailwind's `max-w-4xl` resolves against this project's spacing
  // scale — 120px, not 56rem.
  return (
    <div class="flex w-full min-w-0 flex-col gap-4 py-2">
      {/* Outside the boundary below: the clone URL needs no request, so the
          header is there from the first paint and the branch and commit fill in
          beside it rather than the whole row appearing at once. */}
      <div class="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
        <Show when={overview.data()}>
          {(summary) => (
            <>
              <span class="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-neutral-500/10 px-2 py-1 font-medium text-size-small">
                <Icon name="source-code" class="size-4 opacity-50" />
                {summary().branch}
              </span>
              <Show when={summary().head}>
                {(head) => (
                  <span class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-neutral-500 text-size-small">
                    <code class="font-mono">{head().shortOid}</code>
                    <span class="truncate text-foreground">{head().subject}</span>
                    <span>{head().author}</span>
                    <span>{formatDateTime(head().authoredAt, locale)}</span>
                  </span>
                )}
              </Show>
            </>
          )}
        </Show>

        {/* One control rather than a field with a button inside it: nesting two
            focusable boxes gives two borders and two focus rings. */}
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

      <Show when={overview.data()} fallback={<Skeleton />}>
        {(summary) => (
          <Show
            when={!summary().empty}
            fallback={
              <div class="flex flex-col items-center gap-1 rounded-lg border border-neutral-500/15 border-dashed py-12">
                <p class="font-medium text-size-medium">Nothing pushed yet</p>
                <p class="text-neutral-500 text-size-small">
                  Push a branch to this URL and its files appear here.
                </p>
              </div>
            }
          >
            {/* Held until the listing is here, not merely the summary: they
                are two requests, and dropping the skeleton after the first
                leaves an empty box that collapses the page and then jumps it
                open when the second lands. */}
            <Show when={entries() || file()} fallback={<Skeleton />}>
              <div class="overflow-hidden rounded-lg border border-neutral-500/15">
                <div class="flex items-center gap-1 border-neutral-500/15 border-b bg-neutral-500/5 px-3 py-2 text-size-small">
                  <button
                    type="button"
                    class="focus-ring rounded px-1 py-0.5 font-medium hover:bg-neutral-500/10"
                    onClick={() => setPath("")}
                  >
                    {documentSlug()}
                  </button>
                  <For each={crumbs(path())}>
                    {(crumb) => (
                      <>
                        <span class="text-neutral-400">/</span>
                        <button
                          type="button"
                          class="focus-ring truncate rounded px-1 py-0.5 hover:bg-neutral-500/10"
                          onClick={() => setPath(crumb.path)}
                        >
                          {crumb.name}
                        </button>
                      </>
                    )}
                  </For>
                  <Show when={file()}>
                    {(blob) => (
                      <span class="ml-auto shrink-0 text-neutral-500 tabular-nums">
                        {formatSize(blob().size)}
                      </span>
                    )}
                  </Show>
                </div>

                <Show when={entries()}>
                  {(list) => (
                    <For
                      each={list()}
                      fallback={
                        <p class="px-3 py-6 text-center text-neutral-500 text-size-small">
                          This folder is empty.
                        </p>
                      }
                    >
                      {(entry: GitTreeEntry) => (
                        <button
                          type="button"
                          class="flex w-full items-center gap-2.5 border-neutral-500/10 border-b px-3 py-1.5 text-left text-size-small last:border-b-0 hover:bg-neutral-500/5"
                          onClick={() => setPath(entry.path)}
                        >
                          <Icon
                            name={entry.type === "tree" ? "folder" : "file"}
                            class={
                              entry.type === "tree"
                                ? "size-4 shrink-0 text-primary-400"
                                : "size-4 shrink-0 text-neutral-400"
                            }
                          />
                          <span class="min-w-0 flex-1 truncate">{entry.name}</span>
                          <span class="shrink-0 text-neutral-400 tabular-nums">
                            {formatSize(entry.size)}
                          </span>
                        </button>
                      )}
                    </For>
                  )}
                </Show>

                <Show when={file()}>
                  {(blob) => (
                    <Show
                      when={blob().text !== null}
                      fallback={
                        <p class="px-3 py-8 text-center text-neutral-500 text-size-small">
                          Not text, or too large to show. Clone the repository to read it.
                        </p>
                      }
                    >
                      <pre class="overflow-x-auto px-3 py-2 font-mono text-size-small leading-relaxed">
                        <code>{blob().text}</code>
                      </pre>
                    </Show>
                  )}
                </Show>
              </div>
            </Show>

            <Show when={readme.data()}>
              {(html) => (
                <div class="mt-4 overflow-hidden rounded-lg border border-neutral-500/15">
                  <div class="flex items-center gap-2 border-neutral-500/15 border-b bg-neutral-500/5 px-3 py-2 text-neutral-500 text-size-small">
                    <Icon name="document" class="size-4" />
                    {readmeEntry()?.name}
                  </div>
                  {/* Sanitized by `renderMessageMarkdown`: a README is
                        untrusted content from whoever pushed it. */}
                  <div
                    class="markdown-content readme-content px-4 py-3"
                    innerHTML={html()}
                  />
                </div>
              )}
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
}
