import { type Accessor, createMemo, createSignal } from "solid-js";
import { api } from "#api/client.ts";
import type { DocumentProperties, DocumentPropertyValue } from "#documents/properties.ts";
import { canonicalPropertyKey } from "#documents/properties.ts";
import { placeholderDocumentTitle } from "#documents/types.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useInfiniteQuery, useMutation, useQueryClient } from "./query.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";
import { useToast } from "./useToast.ts";

/** Rows per page. A database's row count is unbounded, so listing it can
 * never fetch everything in one request — see `getDocumentChildren`. */
const PAGE_SIZE = 500;

export interface DatabaseColumn {
  name: string;
  type: "text" | "number" | "date" | "select" | "document";
  label: string;
}

export interface DatabaseSort {
  key: string;
  order: "asc" | "desc";
}

export interface DatabaseSchema {
  columns: DatabaseColumn[];
}

interface AddRowOptions {
  invalidate?: boolean;
}

interface AddRowMutationVariables {
  properties?: DocumentProperties;
  invalidate: boolean;
}

/** `undefined` when the database declares no schema; its columns are then
 * derived from the rows. A declared schema, even an empty one, is authoritative,
 * or deleting the last column would bring the derived ones back. */
function parseSchema(raw: string | undefined): DatabaseSchema | undefined {
  if (!raw) return undefined;
  return JSON.parse(raw) as DatabaseSchema;
}

/**
 * An accessor, not a string: the view stays mounted when navigating from one
 * database document to another — only the prop changes — so a snapshotted id
 * would keep the first database's rows in the query key forever.
 */
export function useDatabaseRows(
  databaseDocumentId: Accessor<string>,
  sort: Accessor<DatabaseSort | null>,
) {
  const { currentSpaceId: spaceId } = useSpace();
  const queryClient = useQueryClient();
  const toast = useToast();
  // Writes invalidate this prefix, so every cached sort order refetches.
  const databaseKey = createMemo(() => [
    "database_rows",
    spaceId(),
    databaseDocumentId(),
  ]);
  const queryKey = createMemo(() => [...databaseKey(), sort()?.key, sort()?.order]);

  const {
    data,
    isPending: isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }: { pageParam: string | undefined }) => {
      const id = spaceId();
      if (!id) throw new Error("No space ID");
      return await api.documents.get(id, {
        parentId: databaseDocumentId(),
        limit: PAGE_SIZE,
        cursor: pageParam,
        sort: sort()?.key,
        order: sort()?.order,
      });
    },
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    initialPageParam: undefined,
    // A new sort order keeps the current rows up until it lands, rather than
    // blanking the table; another database's rows are never carried over.
    placeholderData: (previous) =>
      previous?.pages[0]?.documents[0]?.parentId === databaseDocumentId()
        ? previous
        : undefined,
    enabled: createMemo(() => !!spaceId() && !!databaseDocumentId()),
  });

  const rows = createMemo(() => data()?.pages.flatMap((page) => page.documents) ?? []);

  const [schemaStr, writeSchemaStr] = createSignal<string | undefined>(undefined);

  const schema = createMemo(() => parseSchema(schemaStr()));

  function setSchemaStr(raw: string | undefined) {
    writeSchemaStr(raw);
  }

  const derivedColumns = createMemo<DatabaseColumn[]>(() => {
    const declared = schema();
    if (declared) return declared.columns;
    const columnKeys = new Map<string, string>();
    for (const row of rows()) {
      for (const key of Object.keys(row.properties)) {
        const canonical = canonicalPropertyKey(key);
        if (canonical === "title" || columnKeys.has(canonical)) continue;
        columnKeys.set(canonical, key);
      }
    }
    return Array.from(columnKeys.values()).map((k) => ({
      name: k,
      type: "text" as const,
      label: k,
    }));
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
        queryClient.invalidateQueries({ queryKey: databaseKey() });
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Failed to add row");
    },
  });

  const updateRowPropertyMutation = useMutation({
    mutationFn: async (params: {
      rowId: string;
      name: string;
      value: DocumentPropertyValue;
    }) => {
      const id = spaceId();
      if (!id) throw new Error("No space ID");
      await api.document.patch(id, params.rowId, {
        properties: { [params.name]: { value: params.value } },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: databaseKey() });
    },
  });

  const deleteRowMutation = useMutation({
    mutationFn: async (rowId: string) => {
      const id = spaceId();
      if (!id) throw new Error("No space ID");
      await api.document.archive(id, rowId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: databaseKey() });
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

  /** Every row in the current sort order, not just the pages loaded so far. */
  async function fetchAllRows() {
    const id = spaceId();
    if (!id) throw new Error("No space ID");
    const all = [];
    let cursor: string | undefined;
    do {
      const page = await api.documents.get(id, {
        parentId: databaseDocumentId(),
        limit: PAGE_SIZE,
        cursor,
        sort: sort()?.key,
        order: sort()?.order,
      });
      all.push(...page.documents);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return all;
  }

  function refreshRows() {
    queryClient.invalidateQueries({ queryKey: databaseKey() });
  }

  async function addRow(properties?: DocumentProperties, options?: AddRowOptions) {
    return await addRowMutation.mutateAsync({
      properties,
      invalidate: options?.invalidate ?? true,
    });
  }

  async function updateRowProperty(
    rowId: string,
    name: string,
    value: DocumentPropertyValue,
  ) {
    await updateRowPropertyMutation.mutateAsync({ rowId, name, value });
  }

  async function deleteRow(rowId: string) {
    await deleteRowMutation.mutateAsync(rowId);
  }

  async function addColumn(column: DatabaseColumn) {
    await addColumns([column]);
  }

  async function addColumns(columns: DatabaseColumn[]) {
    if (columns.length === 0) return;
    const currentColumns = derivedColumns();
    const existing = new Set(
      currentColumns.map((column) => canonicalPropertyKey(column.name)),
    );
    const appended = columns.filter((column) => {
      const canonical = canonicalPropertyKey(column.name);
      if (existing.has(canonical)) return false;
      existing.add(canonical);
      return true;
    });
    if (appended.length === 0) return;
    const updated: DatabaseSchema = {
      columns: [...currentColumns, ...appended],
    };
    await updateSchemaMutation.mutateAsync(updated);
  }

  async function deleteColumn(columnName: string) {
    // From the displayed columns: without a declared schema they are derived
    // from the rows, and the schema written here declares them from now on.
    const updated: DatabaseSchema = {
      columns: derivedColumns().filter((c) => c.name !== columnName),
    };
    await updateSchemaMutation.mutateAsync(updated);
  }

  async function changeColumnType(columnName: string, type: DatabaseColumn["type"]) {
    const updated: DatabaseSchema = {
      columns: derivedColumns().map((c) => (c.name === columnName ? { ...c, type } : c)),
    };
    await updateSchemaMutation.mutateAsync(updated);
  }

  /** The values rows already hold for a column, offered as a select's options. */
  async function listColumnValues(columnName: string): Promise<string[]> {
    const id = spaceId();
    if (!id) throw new Error("No space ID");
    return (await api.properties.values(id, columnName, { limit: 500 })).values;
  }

  async function renameColumn(from: string, to: string) {
    const id = spaceId();
    if (!id) throw new Error("No space ID");
    const { schema: renamed } = await api.document.renameColumn(
      id,
      databaseDocumentId(),
      from,
      to,
    );
    if (renamed) writeSchemaStr(renamed);
    refreshRows();
  }

  useSync(spaceId, [realtimeTopics.properties], (_keys) => {
    queryClient.invalidateQueries({ queryKey: databaseKey() });
  });

  return {
    rows,
    derivedColumns,
    isLoading,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    setSchemaStr,
    addRow,
    refreshRows,
    fetchAllRows,
    updateRowProperty,
    deleteRow,
    addColumn,
    addColumns,
    deleteColumn,
    renameColumn,
    changeColumnType,
    listColumnValues,
  };
}
