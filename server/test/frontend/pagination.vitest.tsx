import { createSignal, createRoot as solidCreateRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, setFallbackQueryClient } from "#composeables/query.ts";
import { useCursorPagedList } from "#composeables/useCursorPagedList.ts";

/**
 * The two pagination shapes. They are not duplicates: a **pager** replaces the
 * visible page and can go back; an **infinite query** accumulates and only
 * moves forward. They are composables rather than components, so they run
 * inside a throwaway host.
 */

const hosts: Array<() => void> = [];
afterEach(() => {
  for (const dispose of hosts.splice(0)) dispose();
});

async function settle(times = 8) {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Three pages of two items, cursor-based. */
function pagedFetcher() {
  const pages: Record<string, { items: string[]; nextCursor: string | null }> = {
    start: { items: ["a", "b"], nextCursor: "c2" },
    c2: { items: ["c", "d"], nextCursor: "c3" },
    c3: { items: ["e", "f"], nextCursor: null },
  };
  return vi.fn(
    async ({ cursor }: { limit: number; cursor?: string }) => pages[cursor ?? "start"]!,
  );
}

function runInRoot<T>(setup: () => T): T {
  let result!: T;
  const dispose = solidCreateRoot((disposeRoot) => {
    // A fresh client per spec: these share query keys, and a warm cache from a
    // previous test would make "did it refetch?" assertions meaningless.
    setFallbackQueryClient(new QueryClient());
    result = setup();
    return disposeRoot;
  });
  hosts.push(dispose);
  return result;
}

describe("useCursorPagedList (pager)", () => {
  it("shows one page at a time and can move both ways", async () => {
    const fetcher = pagedFetcher();
    const pager = runInRoot(() =>
      useCursorPagedList<string>({ queryKey: ["sp"], fetcher, pageSize: 2 }),
    );
    await settle();

    expect(pager.items()).toEqual(["a", "b"]);
    expect(pager.hasPrevPage()).toBe(false);
    expect(pager.hasNextPage()).toBe(true);

    pager.nextPage();
    await settle();
    // Replaced, not accumulated — the whole difference from an infinite query.
    expect(pager.items()).toEqual(["c", "d"]);
    expect(pager.hasPrevPage()).toBe(true);

    pager.prevPage();
    await settle();
    expect(pager.items()).toEqual(["a", "b"]);
    expect(pager.hasPrevPage()).toBe(false);
  });

  it("stops at the last page", async () => {
    const fetcher = pagedFetcher();
    const pager = runInRoot(() =>
      useCursorPagedList<string>({ queryKey: ["sq"], fetcher, pageSize: 2 }),
    );
    await settle();
    pager.nextPage();
    await settle();
    pager.nextPage();
    await settle();

    expect(pager.items()).toEqual(["e", "f"]);
    expect(pager.hasNextPage()).toBe(false);

    pager.nextPage();
    await settle();
    expect(pager.items()).toEqual(["e", "f"]);
  });

  it("serves a revisited page from cache with no loading flash", async () => {
    const fetcher = pagedFetcher();
    const pager = runInRoot(() =>
      useCursorPagedList<string>({ queryKey: ["sr"], fetcher, pageSize: 2 }),
    );
    await settle();
    pager.nextPage();
    await settle();
    const afterForward = fetcher.mock.calls.length;

    pager.prevPage();
    await settle();

    expect(pager.items()).toEqual(["a", "b"]);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(afterForward + 1);
    expect(pager.isLoading()).toBe(false);
  });

  it("returns to the first page when the base key changes", async () => {
    const fetcher = pagedFetcher();
    const [listId, setListId] = createSignal("one");
    const pager = runInRoot(() =>
      useCursorPagedList<string>({
        queryKey: () => ["sk", listId()],
        fetcher,
        pageSize: 2,
      }),
    );
    await settle();
    pager.nextPage();
    await settle();
    expect(pager.hasPrevPage()).toBe(true);

    // A different list entirely; keeping the cursor would page into it at an
    // offset that means nothing there.
    setListId("two");
    await settle();
    expect(pager.hasPrevPage()).toBe(false);
    expect(pager.items()).toEqual(["a", "b"]);
  });
});
