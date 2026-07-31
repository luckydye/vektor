import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Smoke coverage for the ported query-wrapper composables.
 *
 * These are thin by design, so there is little logic to test — but "thin" is
 * exactly what makes a mechanical port dangerous: a mis-rewritten `.value`
 * typechecks fine as long as the shape happens to match, and nothing else in
 * the suite calls them. This asserts the one thing that would break silently:
 * that reading an accessor returns data the query actually fetched.
 */

const spaces = [
  { id: "space_1", name: "First", slug: "first" },
  { id: "space_2", name: "Second", slug: "second" },
];

vi.mock("#api/client.ts", () => ({
  api: {
    spaces: {
      get: async () => spaces,
      getCached: async () => undefined,
      subscribeCached: () => () => {},
    },
    documents: {
      get: async (spaceId: string) => ({ documents: [{ id: `doc_${spaceId}` }] }),
      getCached: async () => undefined,
      subscribeCached: () => () => {},
    },
    spaceMembers: { get: async (spaceId: string) => [{ id: `member_${spaceId}` }] },
    subscribeToTopics: () => () => {},
  },
}));

const { QueryClient, setFallbackQueryClient } = await import(
  "#composeables/query.solid.ts"
);
const { useSpace } = await import("#composeables/useSpace.solid.ts");
const { useDocuments } = await import("#composeables/useDocuments.solid.ts");
const { useMembers } = await import("#composeables/useMembers.solid.ts");

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

describe("ported query composables", () => {
  it("useSpace resolves the current space and its id", async () => {
    const space = inRoot(() => useSpace());
    await settle();

    expect(space.spaces()).toHaveLength(2);
    // No active id in context, so it falls back to the first space.
    expect(space.currentSpace()?.slug).toBe("first");
    expect(space.currentSpaceId()).toBe("space_1");
    expect(space.spaceNotFound()).toBe(false);
  });

  it("useSpace honours an explicit override", async () => {
    const space = inRoot(() => useSpace(() => "space_2"));
    await settle();
    expect(space.currentSpaceId()).toBe("space_2");
  });

  it("useDocuments reads through the resolved space", async () => {
    const documents = inRoot(() => useDocuments());
    await settle();
    expect(documents.documents()).toEqual([{ id: "doc_space_1" }]);
    expect(documents.isLoading()).toBe(false);
  });

  it("useMembers reads through the resolved space", async () => {
    const members = inRoot(() => useMembers());
    await settle();
    expect(members.members()).toEqual([{ id: "member_space_1" }]);
  });
});
