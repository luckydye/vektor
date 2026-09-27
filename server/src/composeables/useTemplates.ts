import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import { optionalPropertyValueToText } from "#documents/properties.ts";
import { type DocumentTemplate, templatePropertyKey } from "#documents/templates.ts";
import { templatePreviewText } from "#editor/templates.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";

/**
 * Templates are ordinary documents wearing a marker property, so search with a
 * value-less property filter is the whole lookup: it already resolves the
 * marker, skips archived documents, and drops the ones the reader cannot see.
 */
const templateFilter = JSON.stringify([{ key: templatePropertyKey, value: null }]);

/**
 * Enough templates that a space never silently loses one from the picker,
 * small enough that the picker is not a bulk content download.
 */
const templateLimit = 100;

export function useTemplates() {
  const { currentSpaceId: spaceId } = useSpace();

  const {
    data,
    isPending: isLoading,
    error,
  } = useQuery({
    queryKey: createMemo(() => ["wiki_templates", spaceId()]),
    queryFn: async (): Promise<DocumentTemplate[]> => {
      const currentSpaceId = spaceId();
      if (!currentSpaceId) throw new Error("No space ID");

      const response = await api.search.get(currentSpaceId, {
        filters: templateFilter,
        limit: templateLimit,
      });

      // A template is inserted into a rich text editor, so one written as a
      // canvas or a workflow has nothing to contribute to it.
      const richTextResults = response.results.filter(
        (result) => (result.type ?? "document") === "document",
      );

      return richTextResults
        .map((result) => ({
          id: result.id,
          title: optionalPropertyValueToText(result.properties.title) || "Untitled",
          description: templatePreviewText(result.content),
          content: result.content,
        }))
        .sort((left, right) => left.title.localeCompare(right.title));
    },
    enabled: createMemo(() => !!spaceId()),
  });

  const templates = createMemo(() => data() ?? []);

  return { templates, isLoading, error };
}
