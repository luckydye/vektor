import { type Accessor, createMemo, createSignal } from "solid-js";
import { api } from "#api/client.ts";
import type { DocumentPropertyValue } from "#documents/properties.ts";
import { placeholderDocumentTitle } from "#documents/types.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useMutation, useQuery, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";
import { useToast } from "./useToast.ts";

export interface DatabaseColumn {
  name: string;
  type: "text" | "number" | "date" | "select";
  label: string;
}

export interface DatabaseSchema {
  columns: DatabaseColumn[];
}

interface AddRowOptions {
  invalidate?: boolean;
}

interface AddRowMutationVariables {
  properties?: Record<string, DocumentPropertyValue>;
  invalidate: boolean;
}

function parseSchema(raw: string | undefined): DatabaseSchema {
  if (!raw) return { columns: [] };
  try {
    return JSON.parse(raw) as DatabaseSchema;
  } catch {
    return { columns: [] };
  }
}

/**
 * An accessor, not a string: the view stays mounted when navigating from one
 * database document to another — only the prop changes — so a snapshotted id
 * would keep the first database's rows in the query key forever.
 */
export function useDatabaseRows(databaseDocumentId: Accessor<string>) {
  const { currentSpaceId: spaceId } = useSpace();
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryKey = createMemo(() => ["database_rows", spaceId(), databaseDocumentId()]);

  const { data, isPending: isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const id = spaceId();
      if (!id) throw new Error("No space ID");
      return await api.documents.get(id, {
        parentId: databaseDocumentId(),
        limit: 500,
      });
    },
    enabled: createMemo(() => !!spaceId() && !!databaseDocumentId()),
  });

  const rows = createMemo(() => data()?.documents ?? []);

  const [schemaStr, writeSchemaStr] = createSignal<string | undefined>(undefined);

  const schema = createMemo<DatabaseSchema>(() => parseSchema(schemaStr()));

  function setSchemaStr(raw: string | undefined) {
    writeSchemaStr(raw);
  }

  const derivedColumns = createMemo<DatabaseColumn[]>(() => {
    if (schema().columns.length > 0) return schema().columns;
    const keySet = new Set<string>();
    for (const row of rows()) {
      for (const key of Object.keys(row.properties)) {
        if (key !== "title") keySet.add(key);
      }
    }
    return Array.from(keySet).map((k) => ({ name: k, type: "text" as const, label: k }));
  });

  const addRowMutation = useMutation({
    mutationFn: async ({ properties }: AddRowMutationVariables) => {
      const id = spaceId();
      if (!id) throw new Error("No space ID");
      const title = properties?.title
        ? properties.title
        : placeholderDocumentTitle("record");
      return await api.documents.post(id, {
        content: "<p></p>",
        type: "record",
        parentId: databaseDocumentId(),
        properties: { ...properties, title },
      });
    },
    onSuccess: (_data, variables) => {
      if (variables.invalidate) {
        queryClient.invalidateQueries({ queryKey: queryKey() });
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to add row");
    },
  });

  const updateRowPropertyMutation = useMutation({
    mutationFn: async (params: { rowId: string; name: string; value: string }) => {
      const id = spaceId();
      if (!id) throw new Error("No space ID");
      await api.document.patch(id, params.rowId, {
        properties: { [params.name]: { value: params.value } },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKey() });
    },
  });

  const deleteRowMutation = useMutation({
    mutationFn: async (rowId: string) => {
      const id = spaceId();
      if (!id) throw new Error("No space ID");
      await api.document.archive(id, rowId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKey() });
    },
  });

  const updateSchemaMutation = useMutation({
    mutationFn: async (newSchema: DatabaseSchema) => {
      const id = spaceId();
      if (!id) throw new Error("No space ID");
      writeSchemaStr(JSON.stringify(newSchema));
      await api.document.patch(id, databaseDocumentId(), {
        properties: { _schema: { value: JSON.stringify(newSchema) } },
      });
    },
  });

  function refreshRows() {
    queryClient.invalidateQueries({ queryKey: queryKey() });
  }

  async function addRow(
    properties?: Record<string, DocumentPropertyValue>,
    options?: AddRowOptions,
  ) {
    return await addRowMutation.mutateAsync({
      properties,
      invalidate: options?.invalidate ?? true,
    });
  }

  async function updateRowProperty(rowId: string, name: string, value: string) {
    await updateRowPropertyMutation.mutateAsync({ rowId, name, value });
  }

  async function deleteRow(rowId: string) {
    await deleteRowMutation.mutateAsync(rowId);
  }

  async function addColumn(column: DatabaseColumn) {
    const currentColumns = derivedColumns();
    const updated: DatabaseSchema = {
      columns: [...currentColumns, column],
    };
    await updateSchemaMutation.mutateAsync(updated);
  }

  async function addColumns(columns: DatabaseColumn[]) {
    if (columns.length === 0) return;
    const currentColumns = derivedColumns();
    const existing = new Set(currentColumns.map((column) => column.name));
    const appended = columns.filter((column) => !existing.has(column.name));
    if (appended.length === 0) return;
    const updated: DatabaseSchema = {
      columns: [...currentColumns, ...appended],
    };
    await updateSchemaMutation.mutateAsync(updated);
  }

  async function deleteColumn(columnName: string) {
    const current = schema();
    const updated: DatabaseSchema = {
      columns: current.columns.filter((c) => c.name !== columnName),
    };
    await updateSchemaMutation.mutateAsync(updated);
  }

  useSync(spaceId, [realtimeTopics.properties], (_keys) => {
    queryClient.invalidateQueries({ queryKey: queryKey() });
  });

  return {
    rows,
    derivedColumns,
    isLoading,
    setSchemaStr,
    addRow,
    refreshRows,
    updateRowProperty,
    deleteRow,
    addColumn,
    addColumns,
    deleteColumn,
  };
}
