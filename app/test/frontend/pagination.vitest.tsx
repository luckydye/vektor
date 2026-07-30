import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { QueryClient, QueryPlugin, useInfiniteQuery } from "#composeables/query.ts";
import { useCursorPagedList } from "#composeables/useCursorPagedList.ts";

/**
 * The two pagination shapes (plan section 3.5). They are not duplicates and
 * both get ported, so both need a contract: a **pager** replaces the visible
 * page and can go back; an **infinite query** accumulates and only moves
 * forward. Nothing else covers them, and they are composables rather than
 * components, so they run inside a throwaway host.
 */

const hosts: Array<() => void> = [];
afterEach(() => {
  for (const dispose of hosts.splice(0)) dispose();
});

function runInSetup<T>(setup: () => T): T {
  let result!: T;
  const Host = defineComponent({
    setup() {
      result = setup();
      return () => h("div");
    },
  });
  const app = createApp(Host);
  // A fresh client per spec: these share query keys, and a warm cache from a
  // previous test would make "did it refetch?" assertions meaningless.
  app.use(QueryPlugin, { queryClient: new QueryClient() });
  const el = document.createElement("div");
  document.body.append(el);
  app.mount(el);
  hosts.push(() => {
    app.unmount();
    el.remove();
  });
  return result;
}

async function settle(times = 8) {
  for (let i = 0; i < times; i++) {
    await nextTick();
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

describe("useCursorPagedList (pager)", () => {
  it("shows one page at a time and can move both ways", async () => {
    const fetcher = pagedFetcher();
    const pager = runInSetup(() =>
      useCursorPagedList<string>({ queryKey: ["p"], fetcher, pageSize: 2 }),
    );
    await settle();

    expect(pager.items.value).toEqual(["a", "b"]);
    expect(pager.hasPrevPage.value).toBe(false);
    expect(pager.hasNextPage.value).toBe(true);

    pager.nextPage();
    await settle();
    // Replaced, not accumulated — the whole difference from an infinite query.
    expect(pager.items.value).toEqual(["c", "d"]);
    expect(pager.hasPrevPage.value).toBe(true);

    pager.prevPage();
    await settle();
    expect(pager.items.value).toEqual(["a", "b"]);
    expect(pager.hasPrevPage.value).toBe(false);
  });

  it("stops at the last page", async () => {
    const fetcher = pagedFetcher();
    const pager = runInSetup(() =>
      useCursorPagedList<string>({ queryKey: ["q"], fetcher, pageSize: 2 }),
    );
    await settle();
    pager.nextPage();
    await settle();
    pager.nextPage();
    await settle();

    expect(pager.items.value).toEqual(["e", "f"]);
    expect(pager.hasNextPage.value).toBe(false);

    pager.nextPage();
    await settle();
    expect(pager.items.value).toEqual(["e", "f"]);
  });

  it("serves a revisited page from cache with no loading flash", async () => {
    const fetcher = pagedFetcher();
    const pager = runInSetup(() =>
      useCursorPagedList<string>({ queryKey: ["r"], fetcher, pageSize: 2 }),
    );
    await settle();
    pager.nextPage();
    await settle();
    const afterForward = fetcher.mock.calls.length;

    pager.prevPage();
    await settle();

    expect(pager.items.value).toEqual(["a", "b"]);
    // The cached cursor means going back is one hop, never a re-walk forward
    // from the first page; the entry may still revalidate behind the items.
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(afterForward + 1);
    // The visible guarantee: cached items render straight away, so the reader
    // never sees the list empty itself and refill on the way back.
    expect(pager.isLoading.value).toBe(false);
  });
});

describe("useInfiniteQuery (accumulating)", () => {
  it("appends each page instead of replacing", async () => {
    const pages: Record<string, { items: string[]; next?: string }> = {
      start: { items: ["a", "b"], next: "p2" },
      p2: { items: ["c", "d"], next: undefined },
    };
    const query = runInSetup(() =>
      useInfiniteQuery<{ items: string[]; next?: string }, string | undefined>({
        queryKey: ["inf"],
        initialPageParam: undefined,
        queryFn: async ({ pageParam }) => pages[pageParam ?? "start"]!,
        getNextPageParam: (last) => last.next,
      }),
    );
    await settle();

    const all = () => (query.data.value?.pages ?? []).flatMap((page) => page.items);
    expect(all()).toEqual(["a", "b"]);
    expect(query.hasNextPage.value).toBe(true);

    await query.fetchNextPage();
    await settle();
    // Accumulated — the first page is still there.
    expect(all()).toEqual(["a", "b", "c", "d"]);
    expect(query.hasNextPage.value).toBe(false);
  });
});
