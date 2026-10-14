import { createMemo } from "solid-js";
import { api } from "#api/client.ts";
import {
  DOCUMENT_TYPE_FILTER_KEY,
  optionalPropertyValueToText,
} from "#documents/properties.ts";
import { useQuery } from "./query.ts";
import { useSpace } from "./useSpace.ts";

const workflowFilter = JSON.stringify([{ key: DOCUMENT_TYPE_FILTER_KEY, value: "workflow" }]);

/** Enough for a picker; a space with more workflows than this is not the common case. */
const workflowLimit = 100;

export interface WorkflowSummary {
  id: string;
  title: string;
}

/** The workflows of the current space the reader can see, sorted by title. */
export function useWorkflows() {
  const { currentSpaceId: spaceId } = useSpace();

  const { data } = useQuery({
    queryKey: createMemo(() => ["wiki_workflows", spaceId()]),
    queryFn: async (): Promise<WorkflowSummary[]> => {
      const currentSpaceId = spaceId();
      if (!currentSpaceId) throw new Error("No space ID");

      const response = await api.search.get(currentSpaceId, {
        filters: workflowFilter,
        limit: workflowLimit,
      });
      return response.results
        .map((result) => ({
          id: result.id,
          title: optionalPropertyValueToText(result.properties.title) || "Untitled",
        }))
        .sort((left, right) => left.title.localeCompare(right.title));
    },
    enabled: createMemo(() => !!spaceId()),
  });

  const workflows = createMemo(() => data() ?? []);

  return { workflows };
}
