import type { Model } from "@ironcalc/wasm";
import {
  createMemo,
  createSignal,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { api } from "#api/client.ts";
import { useQuery } from "#composeables/query.ts";
import type { SaveStatus } from "#composeables/useDocument.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useSync } from "#composeables/useSync.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { Spreadsheet } from "#spreadsheet/Spreadsheet.tsx";
import { t } from "#utils/lang.ts";

interface Props {
  documentId: string;
  /** The document's stored table, so the first paint needs no request. */
  initialHtml?: string;
  canEdit: boolean;
}

/** How long to wait after the last edit before writing the document. */
const SAVE_DEBOUNCE_MS = 1200;

/**
 * Spreadsheet view for `csv` documents.
 *
 * The document's content column holds the grid as a `<table>`; it is loaded into
 * an IronCalc model on mount and written back, debounced, after an edit. There
 * is no CRDT here — two people editing the same csv at once is last-writer-wins
 * per save, unlike the collaborative rich-text documents.
 */
export function CsvView(props: Props) {
  const { currentSpaceId } = useSpace();
  const documentId = createMemo(() => props.documentId);

  const [model, setModel] = createSignal<Model | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [saveStatus, setSaveStatus] = createSignal<SaveStatus>("idle");
  // True from the first edit until its save lands. While set, an incoming
  // realtime change is not pulled in — it would throw away what is being typed.
  const [dirty, setDirty] = createSignal(false);
  const [pendingReload, setPendingReload] = createSignal(false);

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let toDocumentHtml: ((model: Model) => string) | undefined;

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
    return typeof content === "string" ? content : (props.initialHtml ?? "");
  });

  // The engine is a ~2 MB wasm module and the grid renderer only runs in a
  // browser, so both are loaded here rather than imported at the top level:
  // this component is server-rendered as part of the document page.
  onMount(async () => {
    try {
      const [{ initEngine }, csvDocument] = await Promise.all([
        import("#spreadsheet/engine.ts"),
        import("#spreadsheet/csvDocument.ts"),
      ]);
      await initEngine();
      toDocumentHtml = csvDocument.toDocumentHtml;
      const title = (documentData()?.properties?.title as string) || "Sheet1";
      setModel(csvDocument.createModel(html(), title));
    } catch (error) {
      setLoadError(String(error));
    }
  });

  const save = async () => {
    const current = model();
    const spaceId = currentSpaceId();
    if (!current || !spaceId || !toDocumentHtml) return;
    setSaveStatus("saving");
    try {
      await api.document.put(spaceId, documentId(), toDocumentHtml(current));
      setDirty(false);
      setSaveStatus("saved");
      setTimeout(() => {
        if (saveStatus() === "saved") setSaveStatus("idle");
      }, 2000);
    } catch {
      setSaveStatus("error");
    }
  };

  const onChange = () => {
    if (!props.canEdit) return;
    setDirty(true);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
  };

  // A hidden tab is not worth a fetch; catch up when it comes back.
  const handleVisibilityChange = () => {
    if (!pendingReload() || dirty()) return;
    if (document.visibilityState !== "visible") return;
    setPendingReload(false);
    refreshDocument();
  };

  onMount(() => {
    window.addEventListener("visibilitychange", handleVisibilityChange);
    onCleanup(() => {
      window.removeEventListener("visibilitychange", handleVisibilityChange);
      clearTimeout(saveTimer);
    });
  });

  // A re-upload or an import replaces the content underneath us. Our own saves
  // come back through here too, which is why a dirty document ignores them.
  useSync(
    currentSpaceId,
    () => [realtimeTopics.document(documentId())],
    (scopes) => {
      if (!scopes.includes(realtimeTopics.document(documentId()))) return;
      if (dirty()) return;
      if (document.visibilityState === "visible") refreshDocument();
      else setPendingReload(true);
    },
  );

  return (
    <main class="relative flex h-[calc(100vh-12rem)] min-h-0 flex-col">
      <Switch>
        <Match when={loadError()}>
          <p class="p-2xs text-neutral-500 text-size-normal">
            {t("The spreadsheet could not be loaded.")} {loadError()}
          </p>
        </Match>
        <Match when={model()}>
          {(loaded) => (
            <Spreadsheet model={loaded()} canEdit={props.canEdit} onChange={onChange} />
          )}
        </Match>
        <Match when={!model()}>
          <p class="p-2xs text-neutral-400 text-size-normal">{t("Loading…")}</p>
        </Match>
      </Switch>

      <Show when={saveStatus() !== "idle"}>
        <span class="pointer-events-none absolute top-4xs right-4xs text-neutral-400 text-size-extra-small">
          <Switch>
            <Match when={saveStatus() === "saving"}>{t("Saving…")}</Match>
            <Match when={saveStatus() === "saved"}>{t("Saved")}</Match>
            <Match when={saveStatus() === "error"}>{t("Could not save")}</Match>
          </Switch>
        </span>
      </Show>
    </main>
  );
}
