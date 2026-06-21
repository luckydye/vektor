import { computed, ref } from "vue";
import { api } from "../api/client.ts";
import { realtimeTopics } from "../utils/realtime.ts";
import { useMutation, useQuery, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";

export interface DatabaseColumn {
  name: string;
  type: "text" | "number" | "date" | "select";
  label: string;
}

export interface DatabaseSchema {
  columns: DatabaseColumn[];
}

function parseSchema(raw: string | undefined): DatabaseSchema {
  if (!raw) return { columns: [] };
  try {
    return JSON.parse(raw) as DatabaseSchema;
  } catch {
    return { columns: [] };
  }
}

export function useDatabaseRows(databaseDocumentId: string) {
  const { currentSpaceId: spaceId } = useSpace();
  const queryClient = useQueryClient();
  const queryKey = computed(() => ["database_rows", spaceId.value, databaseDocumentId]);

  const {
    data,
    isPending: isLoading,
    refetch: refresh,
  } = useQuery({
    queryKey,
    queryFn: async () => {
      if (!spaceId.value) throw new Error("No space ID");
      return await api.documents.get(spaceId.value, {
        parentId: databaseDocumentId,
        limit: 500,
      });
    },
    enabled: computed(() => !!spaceId.value),
  });

  const rows = computed(() => data.value?.documents ?? []);

  const schemaStr = ref<string | undefined>(undefined);

  const schema = computed<DatabaseSchema>(() => parseSchema(schemaStr.value));

  function setSchemaStr(raw: string | undefined) {
    schemaStr.value = raw;
  }

  const derivedColumns = computed<DatabaseColumn[]>(() => {
    if (schema.value.columns.length > 0) return schema.value.columns;
    const keySet = new Set<string>();
    for (const row of rows.value) {
      for (const key of Object.keys(row.properties)) {
        if (key !== "title") keySet.add(key);
      }
    }
    return Array.from(keySet).map((k) => ({ name: k, type: "text" as const, label: k }));
  });

  const addRowMutation = useMutation({
    mutationFn: async () => {
      if (!spaceId.value) throw new Error("No space ID");
      return await api.documents.post(spaceId.value, {
        content: "<p></p>",
        type: "record",
        parentId: databaseDocumentId,
        properties: { title: "Untitled" },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKey.value });
    },
  });

  const updateRowPropertyMutation = useMutation({
    mutationFn: async (params: { rowId: string; name: string; value: string }) => {
      if (!spaceId.value) throw new Error("No space ID");
      await api.document.patch(spaceId.value, params.rowId, {
        properties: { [params.name]: { value: params.value } },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKey.value });
    },
  });

  const deleteRowMutation = useMutation({
    mutationFn: async (rowId: string) => {
      if (!spaceId.value) throw new Error("No space ID");
      await api.document.archive(spaceId.value, rowId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKey.value });
    },
  });

  const updateSchemaMutation = useMutation({
    mutationFn: async (newSchema: DatabaseSchema) => {
      if (!spaceId.value) throw new Error("No space ID");
      schemaStr.value = JSON.stringify(newSchema);
      await api.document.patch(spaceId.value, databaseDocumentId, {
        properties: { _schema: { value: JSON.stringify(newSchema) } },
      });
    },
  });

  async function addRow() {
    return await addRowMutation.mutateAsync();
  }

  async function updateRowProperty(rowId: string, name: string, value: string) {
    await updateRowPropertyMutation.mutateAsync({ rowId, name, value });
  }

  async function deleteRow(rowId: string) {
    await deleteRowMutation.mutateAsync(rowId);
  }

  async function addColumn(column: DatabaseColumn) {
    const current = schema.value;
    const updated: DatabaseSchema = {
      columns: [...current.columns, column],
    };
    await updateSchemaMutation.mutateAsync(updated);
  }

  async function deleteColumn(columnName: string) {
    const current = schema.value;
    const updated: DatabaseSchema = {
      columns: current.columns.filter((c) => c.name !== columnName),
    };
    await updateSchemaMutation.mutateAsync(updated);
  }

  useSync(spaceId, [realtimeTopics.properties], (_keys) => {
    queryClient.invalidateQueries({ queryKey: queryKey.value });
  });

  return {
    rows,
    derivedColumns,
    isLoading,
    setSchemaStr,
    addRow,
    updateRowProperty,
    deleteRow,
    addColumn,
    deleteColumn,
  };
}
