import { useNavigate } from "@solidjs/router";
import { type Accessor, createMemo, createSignal } from "solid-js";
import type { IconName } from "#components/Icon.tsx";
import { useDocumentContext } from "#composeables/useDocument.ts";
import { useDocuments } from "#composeables/useDocuments.ts";
import { useAgentAvailable } from "#composeables/useIntegrationAIModel.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useLocale } from "#composeables/useTranslation.ts";
import { documentTypeIcon } from "#documents/icons.ts";
import { propertyValueToText } from "#documents/properties.ts";
import { documentTitle } from "#documents/title.ts";
import { Actions } from "#utils/actions.ts";
import { history } from "#utils/history.ts";
import { t } from "#utils/lang.ts";

type HistoryEntry = { url: string; lastVisited: number };
// biome-ignore lint/suspicious/noExplicitAny: documents are untyped at this layer.
export type QuickSearchDocument = any;

export type QuickSearchResult =
  | { type: "document"; data: QuickSearchDocument; id?: undefined }
  | { type: "action"; id: string; data: { title?: string; description?: string } }
  | { type: "search"; title: string; space: string; id?: undefined }
  | { type: "create"; title: string; id?: undefined }
  | { type: "agent"; title: string; id?: undefined };

/** The action that opens the palette; never offered as a result of itself. */
export const PALETTE_ACTION_ID = "ui:toggle:palatte";

/**
 * Opens quick search where it lives: the sidebar's own field while the sidebar
 * shows one, otherwise the palette. Bound to mod-k.
 */
export const QUICK_SEARCH_ACTION_ID = "search:quick";

const MAX_DOCUMENT_RESULTS = 50;

const RESULT_ICONS: Record<Exclude<QuickSearchResult["type"], "document">, IconName> = {
  action: "bolt",
  search: "search",
  create: "new-document",
  agent: "agent-chat",
};

export function quickSearchSectionLabel(
  type: QuickSearchResult["type"],
  lang: string,
): string {
  if (type === "document") return t("Documents", lang);
  if (type === "action") return t("Actions", lang);
  if (type === "search") return t("Search", lang);
  if (type === "agent") return t("Agent", lang);
  return t("Create", lang);
}

export function quickSearchResultIcon(result: QuickSearchResult): IconName {
  if (result.type === "document") return documentTypeIcon(result.data.type);
  return RESULT_ICONS[result.type];
}

export function quickSearchResultLabel(result: QuickSearchResult, lang: string): string {
  if (result.type === "document") return documentTitle(result.data, lang);
  if (result.type === "action") return result.data.title || result.id;
  if (result.type === "search")
    return t('Search "{query}" in {space}', lang)
      .replace("{query}", result.title)
      .replace("{space}", result.space);
  if (result.type === "agent")
    return t('Ask the agent "{query}"', lang).replace("{query}", result.title);
  return t('Create Document with title "{title}"', lang).replace("{title}", result.title);
}

export function quickSearchResultDescription(
  result: QuickSearchResult,
  lang: string,
): string | undefined {
  if (result.type === "action") return result.data.description;
  if (result.type === "search") return t("Search the full text of every document", lang);
  if (result.type === "create") return t("Open a new document with this title", lang);
  if (result.type === "agent") return t("Start a new agent chat with this message", lang);
  return undefined;
}

interface Options {
  query: Accessor<string>;
  /** While false the results hold still, so a closing surface fades out with them. */
  active: Accessor<boolean>;
}

/**
 * Quick search over the space: recently visited documents first, then actions,
 * then whatever the typed text can become — a full-text search, a new document
 * or a question for the agent. Shared by the command palette and the sidebar.
 */
export function useQuickSearch(options: Options) {
  const lang = useLocale();
  const navigate = useNavigate();
  const { documents } = useDocuments();
  const { documentContext } = useDocumentContext();
  const { currentSpace } = useSpace();
  const agentAvailable = useAgentAvailable();

  const [historyEntries, setHistoryEntries] = createSignal<HistoryEntry[]>([]);

  const lastVisitedByUrl = createMemo(
    () => new Map(historyEntries().map((entry) => [entry.url, entry.lastVisited])),
  );

  const lastVisited = (doc: QuickSearchDocument) =>
    lastVisitedByUrl().get(`/doc/${doc.slug}`) ?? null;

  const results = createMemo<QuickSearchResult[]>((previous) => {
    if (!options.active()) return previous;

    const typed = options.query().trim();
    const query = typed.toLowerCase();
    const results: QuickSearchResult[] = [];

    let docs: QuickSearchDocument[] = documents();
    if (query) {
      docs = docs.filter((doc: QuickSearchDocument) => {
        const titleValue = doc.properties?.title;
        const title = titleValue
          ? propertyValueToText(titleValue).toLowerCase()
          : "untitled";
        return title.includes(query) || (doc.slug?.toLowerCase() || "").includes(query);
      });
    }

    const visited = lastVisitedByUrl();
    const sorted = [...docs].sort((a: QuickSearchDocument, b: QuickSearchDocument) => {
      const aVisited = visited.get(`/doc/${a.slug}`);
      const bVisited = visited.get(`/doc/${b.slug}`);
      if (aVisited !== undefined && bVisited !== undefined) return bVisited - aVisited;
      if (aVisited !== undefined) return -1;
      if (bVisited !== undefined) return 1;
      return 0;
    });

    for (const doc of sorted.slice(0, MAX_DOCUMENT_RESULTS))
      results.push({ type: "document", data: doc });

    for (const [id, action] of Actions.entries()) {
      if (id === PALETTE_ACTION_ID || id === QUICK_SEARCH_ACTION_ID) continue;
      if (!query || Actions.rank(id, query) > 0) {
        results.push({ type: "action", id, data: action });
      }
    }

    // Nothing matched, so the input reads as a question: offer the agent first.
    const askFirst = results.length === 0;
    if (typed && askFirst && agentAvailable()) results.push({ type: "agent", title: typed });

    const space = currentSpace();
    if (typed && space) {
      results.push({ type: "search", title: typed, space: space.name || "this space" });
    }

    if (typed && space) results.push({ type: "create", title: typed });

    if (typed && !askFirst && agentAvailable()) results.push({ type: "agent", title: typed });

    return results;
  }, []);

  /** Where each section begins, for its heading. */
  const sectionStarts = createMemo(() => {
    const starts = new Map<QuickSearchResult["type"], number>();
    results().forEach((result, index) => {
      if (!starts.has(result.type)) starts.set(result.type, index);
    });
    return starts;
  });

  /** Recent visits order the documents; reloaded each time a search opens. */
  async function loadHistory() {
    try {
      setHistoryEntries((await history.getAll()) as HistoryEntry[]);
    } catch (error) {
      console.error("Failed to load history:", error);
      setHistoryEntries([]);
    }
  }

  async function openDocument(doc: QuickSearchDocument) {
    if (!doc?.slug) return;
    const url = `/doc/${doc.slug}`;
    try {
      await history.log(url, documentTitle(doc, lang));
    } catch (error) {
      console.error("Failed to log history:", error);
    }
    if (url.startsWith("/") && !url.startsWith("//")) navigate(url);
    else window.location.href = url;
  }

  function createDocumentWithTitle(title: string) {
    const query = new URLSearchParams({ title });
    // The draft lands where the user already is: under the open document, or in
    // the space root from anywhere without one.
    const parentId = documentContext().documentId;
    if (parentId) query.set("parent", parentId);
    navigate(`/new?${query.toString()}`);
  }

  function searchSpace(query: string) {
    const trimmed = query.trim();
    navigate(trimmed ? `/search?q=${encodeURIComponent(trimmed)}` : "/search");
  }

  function runResult(result: QuickSearchResult) {
    if (result.type === "document") void openDocument(result.data);
    else if (result.type === "action") Actions.run(result.id);
    else if (result.type === "search") searchSpace(result.title);
    else if (result.type === "agent") Actions.emit("ai-chat:ask", { detail: result.title });
    else createDocumentWithTitle(result.title);
  }

  return { results, sectionStarts, lastVisited, loadHistory, runResult, searchSpace };
}

let inlineQuickSearch: (() => boolean) | null = null;

/**
 * Lets an on-screen search field take mod-k from the palette. `focus` reports
 * whether it could: a field that is not shown, as in a collapsed sidebar,
 * declines and the palette opens instead.
 */
export function registerInlineQuickSearch(focus: () => boolean): () => void {
  inlineQuickSearch = focus;
  return () => {
    if (inlineQuickSearch === focus) inlineQuickSearch = null;
  };
}

/** Focuses the registered field, false when there is none on screen. */
export function focusInlineQuickSearch(): boolean {
  return inlineQuickSearch?.() ?? false;
}
