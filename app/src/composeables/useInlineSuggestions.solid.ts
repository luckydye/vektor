import type { Editor } from "@tiptap/core";
import { applyPatch, parsePatch, reversePatch } from "diff";
import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { api } from "#api/client.ts";
import { prettyPrintHtml } from "#utils/html.ts";
import { useRevisions } from "./useRevisions.solid.ts";

export function useInlineSuggestions(options: {
  spaceId: Accessor<string | null | undefined>;
  documentId: Accessor<string | undefined>;
  isEditing: Accessor<boolean>;
  editor: Accessor<Editor | undefined>;
}) {
  const { spaceId, documentId, isEditing, editor } = options;

  const { revisions, saveRevision, fetchHistory, updateRevisionStatus } = useRevisions(
    documentId(),
  );

  const [suggestionPatches, setSuggestionPatches] = createSignal<Record<number, string>>(
    {},
  );

  const openSuggestions = createMemo(() =>
    revisions().filter((r) => r.status === "open"),
  );
  let inlineSuggestionSyncTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadSuggestionPatches() {
    const currentSpaceId = spaceId();
    const currentDocumentId = documentId();
    if (!currentSpaceId || !currentDocumentId) return;

    await fetchHistory();

    const patches = await Promise.all(
      openSuggestions().map(async (suggestion) => {
        const patch = await api.documentDiff.get(
          currentSpaceId,
          currentDocumentId,
          String(suggestion.rev),
        );
        return [suggestion.rev, patch] as const;
      }),
    );

    setSuggestionPatches(Object.fromEntries(patches));
  }

  function buildSingleHunkPatch(patch: string, hunkIndex: number): string {
    const parsed = parsePatch(patch);
    const file = parsed[0];
    if (!file) throw new Error("Patch is empty");

    const hunk = file.hunks[hunkIndex];
    if (!hunk) throw new Error(`Hunk ${hunkIndex} not found`);

    const oldHeader = file.oldHeader ? `\t${file.oldHeader}` : "";
    const newHeader = file.newHeader ? `\t${file.newHeader}` : "";

    const hunkHeader = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;

    return [
      `Index: ${file.index || documentId() || "document"}`,
      "===================================================================",
      `--- ${file.oldFileName}${oldHeader}`,
      `+++ ${file.newFileName}${newHeader}`,
      hunkHeader,
      ...hunk.lines,
      "",
    ].join("\n");
  }

  function setEditorHtml(html: string) {
    const instance = editor();
    if (!instance) throw new Error("Editor is not ready");
    instance.commands.setContent(html);
  }

  function hunkChangesAreAlreadyPresent(currentHtml: string, hunkPatch: string) {
    const hunk = parsePatch(hunkPatch)[0]?.hunks[0];
    if (!hunk) return false;

    const currentLines = new Set(currentHtml.split("\n"));
    const addedLines = hunk.lines
      .filter((line) => line.startsWith("+"))
      .map((line) => line.slice(1))
      .filter((line) => line.trim() !== "" && line.trim() !== "<p></p>");
    const removedLines = hunk.lines
      .filter((line) => line.startsWith("-"))
      .map((line) => line.slice(1))
      .filter((line) => line.trim() !== "" && line.trim() !== "<p></p>");

    // An insertion-only hunk is commonly already present in the persisted
    // collaboration draft after its suggestion was saved. There is nothing to
    // apply in that case, and applying it with relaxed context would duplicate it.
    return (
      addedLines.length > 0 &&
      addedLines.every((line) => currentLines.has(line)) &&
      removedLines.every((line) => !currentLines.has(line))
    );
  }

  function clearQueuedInlineSuggestionsSync() {
    if (!inlineSuggestionSyncTimer) return;
    clearTimeout(inlineSuggestionSyncTimer);
    inlineSuggestionSyncTimer = null;
  }

  function syncInlineSuggestions() {
    const instance = editor();
    if (!instance?.commands) return;

    instance.commands.setInlineSuggestions(
      openSuggestions()
        .filter((s) => suggestionPatches()[s.rev])
        .map((s) => ({
          rev: s.rev,
          message: s.message,
          patch: suggestionPatches()[s.rev],
        })),
    );
  }

  function queueInlineSuggestionsSync(delay = 0) {
    if (!isEditing() || inlineSuggestionSyncTimer) return;

    inlineSuggestionSyncTimer = setTimeout(() => {
      inlineSuggestionSyncTimer = null;
      if (!isEditing()) return;

      if (!editor()?.commands) {
        queueInlineSuggestionsSync(50);
        return;
      }

      syncInlineSuggestions();
    }, delay);
  }

  async function acceptSuggestionHunk(revisionRev: number, hunkIndex: number) {
    const patch = suggestionPatches()[revisionRev];
    if (!patch) throw new Error(`Suggestion patch ${revisionRev} not loaded`);

    const instance = editor();
    if (!instance) throw new Error("Editor is not ready");

    const currentHtml = prettyPrintHtml(instance.getHTML());
    const hunkPatch = buildSingleHunkPatch(patch, hunkIndex);
    let nextHtml = applyPatch(currentHtml, hunkPatch);
    if (nextHtml === false) {
      // The collaboration editor may normalize nearby empty blocks or list
      // markup after a suggestion is created. Keep the tolerance bounded so
      // removals still require an exact match while insertions can follow
      // their surrounding content through small structural changes.
      nextHtml = applyPatch(currentHtml, hunkPatch, { fuzzFactor: 3 });
    }
    if (nextHtml === false) {
      const parsedPatch = parsePatch(hunkPatch)[0];
      const hunkAlreadyApplied =
        parsedPatch !== undefined &&
        (applyPatch(currentHtml, reversePatch(parsedPatch)) !== false ||
          hunkChangesAreAlreadyPresent(currentHtml, hunkPatch));

      if (!hunkAlreadyApplied) {
        throw new Error(
          `Failed to apply suggestion hunk ${hunkIndex + 1} from suggestion ${revisionRev}`,
        );
      }

      nextHtml = currentHtml;
    }

    if (nextHtml !== currentHtml) setEditorHtml(nextHtml);
    const revision = await updateRevisionStatus(revisionRev, "applied");
    if (!revision) throw new Error(`Failed to accept suggestion ${revisionRev}`);

    const { [revisionRev]: _acceptedPatch, ...remainingPatches } = suggestionPatches();
    setSuggestionPatches(remainingPatches);
    syncInlineSuggestions();
  }

  async function declineSuggestion(revisionRev: number) {
    const revision = await updateRevisionStatus(revisionRev, "dismissed");
    if (!revision) throw new Error(`Failed to dismiss suggestion ${revisionRev}`);

    const { [revisionRev]: _dismissedPatch, ...remainingPatches } = suggestionPatches();
    setSuggestionPatches(remainingPatches);
    syncInlineSuggestions();
  }

  async function handleInlineSuggestionAccept(
    event: CustomEvent<{ revisionRev: number; hunkIndex: number }>,
  ) {
    await acceptSuggestionHunk(event.detail.revisionRev, event.detail.hunkIndex);
  }

  async function handleInlineSuggestionDecline(
    event: CustomEvent<{ revisionRev: number; hunkIndex: number }>,
  ) {
    await declineSuggestion(event.detail.revisionRev);
  }

  createEffect(async () => {
    const editing = isEditing();
    if (!editing || !documentId()) {
      clearQueuedInlineSuggestionsSync();
      setSuggestionPatches({});
      editor()?.commands.clearInlineSuggestions();
      return;
    }
    await loadSuggestionPatches();
  });

  createEffect(
    on(suggestionPatches, () => {
      if (!isEditing()) return;
      queueInlineSuggestionsSync();
    }),
  );

  onCleanup(clearQueuedInlineSuggestionsSync);

  return {
    saveRevision,
    handleInlineSuggestionAccept,
    handleInlineSuggestionDecline,
  };
}
