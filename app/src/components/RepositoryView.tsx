import { createResource, createSignal, For, Show } from "solid-js";
import type { GitTreeEntry } from "#api/ApiClient.ts";
import { api } from "#api/client.ts";
import { useRoute } from "#composeables/useRoute.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { formatDateTime } from "#utils/dateFormat.ts";
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
  const [copied, setCopied] = createSignal(false);

  const [overview] = createResource(
    () => ({ spaceId: props.spaceId, documentId: props.documentId }),
    (key) => api.git.overview(key.spaceId, key.documentId),
  );

  const [entries] = createResource(
    () => {
      const summary = overview();
      if (!summary || summary.empty) return null;
      return { rev: summary.branch, path: path() };
    },
    async (key) => {
      const result = await api.git
        .tree(props.spaceId, props.documentId, key.rev, key.path)
        .catch(() => null);
      return result?.entries ?? null;
    },
  );

  // A path with no listing is a file, so the blob is what to render. Asking for
  // both and showing whichever answers keeps navigation to a single click.
  const [file] = createResource(
    () => {
      const summary = overview();
      if (!summary || summary.empty || path() === "" || entries() !== null) return null;
      return { rev: summary.branch, path: path() };
    },
    (key) =>
      api.git.blob(props.spaceId, props.documentId, key.rev, key.path).catch(() => null),
  );

  // The clone URL is the document's own address in git's namespace, so it
  // follows a rename the way every other link to the document does. The origin
  // is read defensively: this runs during server rendering too, where there is
  // no window, and a relative path is what that pass has to show.
  const origin = () => (typeof window === "undefined" ? "" : window.location.origin);
  const cloneUrl = () => `${origin()}/${currentSpace()?.slug}/git/${documentSlug()}.git`;

  async function copyCloneUrl() {
    await navigator.clipboard.writeText(cloneUrl());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div class="flex flex-col gap-6 py-4">
      <div class="flex flex-wrap items-center gap-2 rounded-lg border border-neutral-500/20 p-2 pl-3">
        <Icon name="link" class="opacity-60" />
        <code class="flex-1 overflow-x-auto whitespace-nowrap text-sm">
          git clone {cloneUrl()}
        </code>
        <button
          type="button"
          class="rounded-md px-3 py-1.5 text-sm hover:bg-neutral-500/10"
          onClick={copyCloneUrl}
        >
          {copied() ? "Copied" : "Copy"}
        </button>
      </div>

      <Show when={overview()} fallback={<p class="opacity-60">Loading repository…</p>}>
        {(summary) => (
          <Show
            when={!summary().empty}
            fallback={
              <div class="flex flex-col gap-2 rounded-lg border border-neutral-500/30 border-dashed p-6">
                <p class="font-medium">Nothing pushed yet</p>
                <p class="text-sm opacity-70">
                  Push a branch to this URL and its files will appear here.
                </p>
              </div>
            }
          >
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="rounded-md bg-neutral-500/10 px-2 py-1">
                {summary().branch}
              </span>
              <Show when={summary().head}>
                {(head) => (
                  <span class="flex flex-wrap items-center gap-2 opacity-70">
                    <code>{head().shortOid}</code>
                    <span>{head().subject}</span>
                    <span>· {head().author}</span>
                    <span>· {formatDateTime(head().authoredAt, locale)}</span>
                  </span>
                )}
              </Show>
            </div>

            <Show when={path() !== ""}>
              <div class="flex flex-wrap items-center gap-1 text-sm">
                <button
                  type="button"
                  class="rounded px-1 hover:bg-neutral-500/10"
                  onClick={() => setPath("")}
                >
                  root
                </button>
                <For each={crumbs(path())}>
                  {(crumb) => (
                    <>
                      <span class="opacity-40">/</span>
                      <button
                        type="button"
                        class="rounded px-1 hover:bg-neutral-500/10"
                        onClick={() => setPath(crumb.path)}
                      >
                        {crumb.name}
                      </button>
                    </>
                  )}
                </For>
              </div>
            </Show>

            <Show when={entries()}>
              {(list) => (
                <div class="overflow-hidden rounded-lg border border-neutral-500/20">
                  <For
                    each={list()}
                    fallback={<p class="p-4 text-sm opacity-60">This folder is empty.</p>}
                  >
                    {(entry: GitTreeEntry) => (
                      <button
                        type="button"
                        class="flex w-full items-center gap-3 border-neutral-500/10 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-neutral-500/5"
                        onClick={() => setPath(entry.path)}
                      >
                        <Icon
                          name={entry.type === "tree" ? "folder" : "file"}
                          class="opacity-60"
                        />
                        <span class="flex-1 truncate">{entry.name}</span>
                        <span class="tabular-nums opacity-50">
                          {formatSize(entry.size)}
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              )}
            </Show>

            <Show when={file()}>
              {(blob) => (
                <Show
                  when={blob().text !== null}
                  fallback={
                    <p class="rounded-lg border border-neutral-500/20 p-4 text-sm opacity-70">
                      {formatSize(blob().size)} — too large or not text. Clone the
                      repository to read it.
                    </p>
                  }
                >
                  <pre class="overflow-x-auto rounded-lg border border-neutral-500/20 p-4 text-sm">
                    <code>{blob().text}</code>
                  </pre>
                </Show>
              )}
            </Show>
          </Show>
        )}
      </Show>
    </div>
  );
}
