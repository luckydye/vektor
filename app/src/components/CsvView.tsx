import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { api } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useSync } from "#composeables/useSync.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import "#editor/elements/table-view.ts";

interface Props {
  documentId: string;
  initialHtml?: string;
}

export function CsvView(props: Props) {
  const { currentSpaceId } = useSpace();
  const documentId = createMemo(() => props.documentId);
  const [pendingReload, setPendingReload] = createSignal(false);

  const { data: documentData, refetch: refreshDocument } = useQuery({
    queryKey: createMemo(() => ["wiki_document", currentSpaceId(), documentId()]),
    queryFn: async () => {
      const spaceId = currentSpaceId();
      if (!spaceId) throw new Error("No space ID");
      return await api.document.get(spaceId, documentId());
    },
    enabled: createMemo(() => !!currentSpaceId() && !!documentId()),
  });

  const html = createMemo(() => {
    const content = documentData()?.content;
    return typeof content === "string" ? content : props.initialHtml || "";
  });

  const handleVisibilityChange = () => {
    if (!pendingReload()) return;
    if (document.visibilityState !== "visible") return;
    setPendingReload(false);
    refreshDocument();
  };

  onMount(() => {
    window.addEventListener("visibilitychange", handleVisibilityChange);
    onCleanup(() => {
      window.removeEventListener("visibilitychange", handleVisibilityChange);
    });
  });

  useSync(
    currentSpaceId,
    () => [realtimeTopics.document(documentId())],
    (scopes) => {
      if (!scopes.includes(realtimeTopics.document(documentId()))) return;
      if (document.visibilityState === "visible") refreshDocument();
      else setPendingReload(true);
    },
  );

  return (
    <main class="relative mb-30">
      <table-view prop:html={html()} class="block min-h-0 flex-1" />
    </main>
  );
}
