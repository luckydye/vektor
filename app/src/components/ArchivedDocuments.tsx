import { createMemo, Show } from "solid-js";
import { api } from "#api/client.ts";
import { deleteElementIcon, spinnerIcon } from "#assets/icons.ts";
import { useQuery } from "#composeables/query.ts";
import { DocumentGroupedList } from "./DocumentGroupedList.tsx";

interface Props {
  spaceId: string;
}

export function ArchivedDocuments(props: Props) {
  const {
    data: docs,
    isPending: isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: createMemo(() => ["archived_docs", props.spaceId]),
    queryFn: () =>
      api.documents.archived(props.spaceId, { limit: 500 }).then((r) => r.documents),
  });

  const { data: categories } = useQuery({
    queryKey: createMemo(() => ["categories", props.spaceId]),
    queryFn: () => api.categories.get(props.spaceId).then((r) => r.categories),
  });

  async function handleRestore(documentId: string) {
    try {
      await api.document.restore(props.spaceId, documentId);
      refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to restore document");
    }
  }

  async function handleDelete(documentId: string) {
    if (!confirm("Permanently delete this document? This cannot be undone.")) return;
    try {
      await api.document.delete(props.spaceId, documentId);
      refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete document");
    }
  }

  async function handleBatchRestore(ids: Set<string>, deselectAll: () => void) {
    const count = ids.size;
    if (!confirm(`Restore ${count} document${count !== 1 ? "s" : ""}?`)) return;
    try {
      for (const id of ids) await api.document.restore(props.spaceId, id);
      deselectAll();
      refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to restore documents");
    }
  }

  async function handleBatchDelete(ids: Set<string>, deselectAll: () => void) {
    const count = ids.size;
    if (
      !confirm(
        `Permanently delete ${count} document${count !== 1 ? "s" : ""}? This cannot be undone.`,
      )
    )
      return;
    try {
      for (const id of ids) await api.document.delete(props.spaceId, id);
      deselectAll();
      refetch();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to delete documents");
    }
  }

  return (
    <div>
      <Show
        when={!isLoading()}
        fallback={
          <div class="flex flex-col items-center gap-3 py-12">
            <div
              class="svg-icon h-6 w-6 animate-spin text-neutral-300"
              innerHTML={spinnerIcon}
            />
            <p class="text-neutral-400 text-size-small">Loading archived documents…</p>
          </div>
        }
      >
        <Show
          when={!error()}
          fallback={
            <div class="py-8 text-center">
              <p class="text-red-600 text-size-small">
                {error()?.message ?? "Failed to load archived documents"}
              </p>
            </div>
          }
        >
          <DocumentGroupedList
            items={docs() ?? []}
            categories={categories()}
            emptyText="No archived documents"
            batchActions={(selectedIds, deselectAll) => (
              <>
                <button
                  type="button"
                  onClick={() => void handleBatchRestore(selectedIds, deselectAll)}
                  class="rounded-md border border-neutral-200 px-3 py-1.5 font-medium text-neutral-700 text-size-small transition-colors hover:border-neutral-300 hover:bg-neutral-50"
                >
                  Restore selected
                </button>
                <button
                  type="button"
                  onClick={() => void handleBatchDelete(selectedIds, deselectAll)}
                  class="rounded-md border border-neutral-200 p-1.5 text-neutral-500 transition-colors hover:border-red-300 hover:bg-red-50 hover:text-red-600"
                  title="Delete selected permanently"
                >
                  <div class="svg-icon block h-4 w-4" innerHTML={deleteElementIcon} />
                </button>
              </>
            )}
            rowActions={(doc) => (
              <>
                <button
                  type="button"
                  onClick={() => void handleRestore(doc.id)}
                  class="rounded px-2.5 py-1 font-medium text-[11px] text-neutral-600 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
                >
                  Restore
                </button>
                <button
                  type="button"
                  onClick={() => void handleDelete(doc.id)}
                  class="rounded p-1 text-neutral-400 transition-colors hover:bg-red-50 hover:text-red-600"
                  title="Delete permanently"
                >
                  <div class="svg-icon h-3.5 w-3.5" innerHTML={deleteElementIcon} />
                </button>
              </>
            )}
          />
        </Show>
      </Show>
    </div>
  );
}
