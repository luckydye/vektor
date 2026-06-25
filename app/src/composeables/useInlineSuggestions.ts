import type { Editor } from "@tiptap/core";
import { applyPatch, parsePatch } from "diff";
import { computed, onUnmounted, type Ref, ref, watch } from "vue";
import { prettyPrintHtml } from "../utils/prettyHtml.ts";
import { useRevisions } from "./useRevisions.ts";

export function useInlineSuggestions(options: {
  spaceId: Ref<string | null | undefined>;
  documentId: Ref<string | undefined>;
  isEditing: Ref<boolean>;
  editor: Ref<Editor | undefined>;
}) {
  const { spaceId, documentId, isEditing, editor } = options;

  const { revisions, saveRevision, fetchHistory, updateRevisionStatus } = useRevisions(
    documentId.value,
  );

  const suggestionPatches = ref<Record<number, string>>({});
  const hiddenSuggestionHunks = ref<Set<string>>(new Set());

  const openSuggestions = computed(() =>
    revisions.value.filter((r) => r.status === "open"),
  );
  let inlineSuggestionSyncTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadSuggestionPatches() {
    if (!spaceId.value || !documentId.value) return;

    await fetchHistory();

    const patches = await Promise.all(
      openSuggestions.value.map(async (suggestion) => {
        const response = await fetch(
          `/api/v1/spaces/${spaceId.value}/documents/${documentId.value}/diff?rev=${suggestion.rev}`,
        );
        if (!response.ok) {
          throw new Error(`Failed to fetch diff for suggestion ${suggestion.rev}`);
        }
        return [suggestion.rev, await response.text()] as const;
      }),
    );

    suggestionPatches.value = Object.fromEntries(patches);
  }

  function buildSingleHunkPatch(patch: string, hunkIndex: number): string {
    const parsed = parsePatch(patch);
    const file = parsed[0];
    if (!file) throw new Error("Patch is empty");

    const hunk = file.hunks[hunkIndex];
    if (!hunk) throw new Error(`Hunk ${hunkIndex} not found`);

    const oldHeader = file.oldHeader ? `\t${file.oldHeader}` : "";
    const newHeader = file.newHeader ? `\t${file.newHeader}` : "";

    return [
      `Index: ${file.index || documentId.value || "document"}`,
      "===================================================================",
      `--- ${file.oldFileName}${oldHeader}`,
      `+++ ${file.newFileName}${newHeader}`,
      hunk.content,
      ...hunk.lines,
      "",
    ].join("\n");
  }

  function setEditorHtml(html: string) {
    if (!editor.value) throw new Error("Editor is not ready");
    editor.value.commands.setContent(html);
  }

  function clearQueuedInlineSuggestionsSync() {
    if (!inlineSuggestionSyncTimer) return;
    clearTimeout(inlineSuggestionSyncTimer);
    inlineSuggestionSyncTimer = null;
  }

  function syncInlineSuggestions() {
    if (!editor.value?.commands) return;

    editor.value.commands.setInlineSuggestions(
      openSuggestions.value
        .filter((s) => suggestionPatches.value[s.rev])
        .map((s) => ({
          rev: s.rev,
          message: s.message,
          patch: suggestionPatches.value[s.rev],
          hiddenHunks: Array.from(hiddenSuggestionHunks.value)
            .filter((key) => key.startsWith(`${s.rev}:`))
            .map((key) => Number(key.split(":")[1]))
            .filter((hunkIndex) => Number.isInteger(hunkIndex)),
        })),
    );
  }

  function queueInlineSuggestionsSync(delay = 0) {
    if (!isEditing.value || inlineSuggestionSyncTimer) return;

    inlineSuggestionSyncTimer = setTimeout(() => {
      inlineSuggestionSyncTimer = null;
      if (!isEditing.value) return;

      if (!editor.value?.commands) {
        queueInlineSuggestionsSync(50);
        return;
      }

      syncInlineSuggestions();
    }, delay);
  }

  function acceptSuggestionHunk(revisionRev: number, hunkIndex: number) {
    const patch = suggestionPatches.value[revisionRev];
    if (!patch) throw new Error(`Suggestion patch ${revisionRev} not loaded`);

    if (!editor.value) throw new Error("Editor is not ready");

    const currentHtml = prettyPrintHtml(editor.value.getHTML());
    const nextHtml = applyPatch(currentHtml, buildSingleHunkPatch(patch, hunkIndex));
    if (nextHtml === false) {
      throw new Error(
        `Failed to apply suggestion hunk ${hunkIndex + 1} from suggestion ${revisionRev}`,
      );
    }

    setEditorHtml(nextHtml);
    hideSuggestionHunk(revisionRev, hunkIndex);
  }

  function hideSuggestionHunk(revisionRev: number, hunkIndex: number) {
    const next = new Set(hiddenSuggestionHunks.value);
    next.add(`${revisionRev}:${hunkIndex}`);
    hiddenSuggestionHunks.value = next;
    syncInlineSuggestions();
  }

  async function declineSuggestion(revisionRev: number) {
    const revision = await updateRevisionStatus(revisionRev, "dismissed");
    if (!revision) throw new Error(`Failed to dismiss suggestion ${revisionRev}`);

    const { [revisionRev]: _dismissedPatch, ...remainingPatches } =
      suggestionPatches.value;
    suggestionPatches.value = remainingPatches;
    syncInlineSuggestions();
  }

  function handleInlineSuggestionAccept(
    event: CustomEvent<{ revisionRev: number; hunkIndex: number }>,
  ) {
    acceptSuggestionHunk(event.detail.revisionRev, event.detail.hunkIndex);
  }

  async function handleInlineSuggestionDecline(
    event: CustomEvent<{ revisionRev: number; hunkIndex: number }>,
  ) {
    await declineSuggestion(event.detail.revisionRev);
  }

  watch(
    isEditing,
    async (editing) => {
      if (!editing || !documentId.value) {
        clearQueuedInlineSuggestionsSync();
        suggestionPatches.value = {};
        hiddenSuggestionHunks.value = new Set();
        editor.value?.commands.clearInlineSuggestions();
        return;
      }
      await loadSuggestionPatches();
    },
    { immediate: true },
  );

  watch(
    suggestionPatches,
    () => {
      if (!isEditing.value) return;
      queueInlineSuggestionsSync();
    },
    { deep: true },
  );

  onUnmounted(clearQueuedInlineSuggestionsSync);

  return {
    saveRevision,
    handleInlineSuggestionAccept,
    handleInlineSuggestionDecline,
  };
}
