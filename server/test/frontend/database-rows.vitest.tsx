import { createRoot, createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `useDatabaseRows` against a changing database id.
 *
 * Navigating from one database document to another keeps `DatabaseView`
 * mounted — the route component and the `Match` arm both stay the same, only
 * the prop changes. Everything derived from the document read reactively kept
 * up (the title, the schema-driven columns) while the rows did not, because the
 * id reached the composable as a plain string and was snapshotted into the
 * query key at setup. The result looked like a half-loaded page: second
 * database's name and columns, first database's rows.
 */

const rowsByParent: Record<string, Array<{ id: string; properties: object }>> = {
  db_1: [{ id: "row_a", properties: { title: "First row" } }],
  db_2: [{ id: "row_b", properties: { title: "Second row" } }],
};

const documentsGet = vi.fn(async (_spaceId: string, params: { parentId: string }) => ({
  documents: rowsByParent[params.parentId] ?? [],
}));

vi.mock("#api/client.ts", () => ({
  api: {
    spaces: {
      get: async () => [{ id: "space_1", name: "First", slug: "first" }],
      getCached: async () => undefined,
      subscribeCached: () => () => {},
    },
    documents: {
      get: documentsGet,
      getCached: async () => undefined,
      subscribeCached: () => () => {},
    },
    subscribeToTopics: () => () => {},
  },
}));

const { QueryClient, setFallbackQueryClient } = await import("#composeables/query.ts");
const { useDatabaseRows } = await import("#composeables/useDatabaseRows.ts");

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function inRoot<T>(setup: () => T): T {
  setFallbackQueryClient(new QueryClient());
  let value!: T;
  createRoot((dispose) => {
    disposers.push(dispose);
    value = setup();
  });
  return value;
}

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("useDatabaseRows", () => {
  it("refetches when the database document changes", async () => {
    const [databaseId, setDatabaseId] = createSignal("db_1");
    const database = inRoot(() => useDatabaseRows(databaseId));
    await settle();

    expect(database.rows().map((row) => row.id)).toEqual(["row_a"]);

    setDatabaseId("db_2");
    await settle();

    expect(database.rows().map((row) => row.id)).toEqual(["row_b"]);
    // The second fetch has to carry the new parent, not just miss the cache.
    expect(documentsGet).toHaveBeenLastCalledWith(
      "space_1",
      expect.objectContaining({ parentId: "db_2" }),
    );
  });

  it("derives its columns from the rows of the current database", async () => {
    const [databaseId, setDatabaseId] = createSignal("db_1");
    rowsByParent.db_3 = [{ id: "row_c", properties: { title: "Third", status: "open" } }];

    const database = inRoot(() => useDatabaseRows(databaseId));
    await settle();
    expect(database.derivedColumns()).toEqual([]);

    setDatabaseId("db_3");
    await settle();
    expect(database.derivedColumns().map((column) => column.name)).toEqual(["status"]);
  });
});
