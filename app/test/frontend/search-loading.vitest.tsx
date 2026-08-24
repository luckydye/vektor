import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, setFallbackQueryClient } from "#composeables/query.ts";

/**
 * What the search view says while it is working. The interesting case is the
 * *second* search: the pager keeps the previous page on screen, so a naive
 * "loading" flag is false for it and the reader sees an unchanged page with no
 * sign that their query was even taken.
 */

const navigate = vi.fn();
const [locationSearch, setLocationSearch] = createSignal("");

vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigate,
  useLocation: () => ({
    get search() {
      return locationSearch();
    },
    pathname: "/spaces/first/search",
  }),
}));

vi.mock("#composeables/useSpace.ts", () => ({
  useSpace: () => ({
    currentSpace: () => ({
      id: "space_1",
      slug: "first",
      name: "First",
      userRole: "admin",
    }),
    spaces: () => [],
  }),
}));

/** One hit per query, so a page turn and a fresh query both have rows. */
function hit(id: string) {
  return {
    id,
    slug: id,
    type: "document",
    updatedAt: new Date().toISOString(),
    properties: { title: id },
    rank: 1,
  };
}

let searchResponse: () => Promise<{ results: unknown[]; nextCursor: string | null }>;
let otherSpacesResponse: () => Promise<unknown[]> = async () => [];

const searchGet = vi.fn(() => searchResponse());

vi.mock("#api/client.ts", () => ({
  api: {
    search: {
      get: (...args: unknown[]) => searchGet(...(args as [])),
      otherSpaces: () => otherSpacesResponse(),
    },
    documents: { get: async () => ({ documents: [], nextCursor: null }) },
    properties: { get: async () => [] },
    document: { archive: async () => {} },
    upload: { delete: async () => {} },
  },
}));

const { Search } = await import("#components/Search.tsx");

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  setLocationSearch("");
  searchGet.mockClear();
  otherSpacesResponse = async () => [];
});

async function settle(times = 8) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function mount(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  // A fresh cache per spec: these share query keys, and a warm entry would
  // answer a search that this test wants to catch in flight.
  setFallbackQueryClient(new QueryClient());
  disposers.push(render(() => <Search spaceId="space_1" />, container));
  disposers.push(() => container.remove());
  return container;
}

function searchButton(container: HTMLElement): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find((b) =>
    /Search/.test(b.textContent ?? ""),
  );
  if (!button) throw new Error("no search button");
  return button as HTMLButtonElement;
}

/** Types a query into the field and submits it with Enter, as a reader would. */
function submit(container: HTMLElement, query: string) {
  const input = container.querySelector("input[type=text]") as HTMLInputElement;
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

describe("Search loading feedback", () => {
  it("draws placeholder rows for a first search instead of a blank page", async () => {
    let release!: (value: { results: unknown[]; nextCursor: string | null }) => void;
    searchResponse = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const container = mount();
    await settle();

    submit(container, "alpha");
    await settle();

    expect(searchButton(container).textContent).toContain("Searching…");
    expect(container.querySelector("[role=status]")).not.toBeNull();

    release({ results: [hit("doc_a")], nextCursor: null });
    await settle();

    expect(container.querySelector("[role=status]")).toBeNull();
    expect(container.textContent).toContain("doc_a");
  });

  it("marks the previous results stale while a second search runs", async () => {
    searchResponse = async () => ({ results: [hit("doc_a")], nextCursor: null });

    setLocationSearch("?q=alpha");
    const container = mount();
    await settle();
    expect(container.textContent).toContain("doc_a");

    let release!: (value: { results: unknown[]; nextCursor: string | null }) => void;
    searchResponse = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    submit(container, "beta");
    await settle();

    // The rows stay put — that is the point of the placeholder — so the busy
    // state has to be readable from the button and from the rows themselves.
    expect(container.textContent).toContain("doc_a");
    expect(searchButton(container).textContent).toContain("Searching…");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    release({ results: [hit("doc_b")], nextCursor: null });
    await settle();

    expect(container.textContent).toContain("doc_b");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("holds back the results below the split until the other spaces answer", async () => {
    const hits = Array.from({ length: 8 }, (_, i) => hit(`doc_${i}`));
    searchResponse = async () => ({ results: hits, nextCursor: null });

    let releaseOtherSpaces!: (value: unknown[]) => void;
    otherSpacesResponse = () =>
      new Promise((resolve) => {
        releaseOtherSpaces = resolve;
      });

    setLocationSearch("?q=alpha");
    const container = mount();
    await settle();

    // Five above the panel's slot; the other three belong below it and would be
    // pushed down by it if they were drawn now.
    expect(container.textContent).toContain("doc_4");
    expect(container.textContent).not.toContain("doc_5");
    expect(container.textContent).toContain("Results in other Spaces");
    const pagerButtons = [...container.querySelectorAll("button")].filter((b) =>
      /Previous|Next/.test(b.textContent ?? ""),
    );
    expect(pagerButtons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);

    releaseOtherSpaces([]);
    await settle();

    expect(container.textContent).toContain("doc_7");
  });

  it("draws no panel at all when the other spaces come back empty", async () => {
    searchResponse = async () => ({
      results: Array.from({ length: 8 }, (_, i) => hit(`doc_${i}`)),
      nextCursor: null,
    });
    otherSpacesResponse = async () => [];

    setLocationSearch("?q=alpha");
    const container = mount();
    await settle();

    // A caption over nothing claims results that do not exist.
    expect(container.textContent).toContain("doc_7");
    expect(container.textContent).not.toContain("Results in other Spaces");
  });

  it("leaves the other spaces behind on the second page", async () => {
    searchResponse = async () => ({
      results: Array.from({ length: 8 }, (_, i) => hit(`doc_${i}`)),
      nextCursor: "cursor_2",
    });
    otherSpacesResponse = async () => [
      { ...hit("elsewhere"), spaceId: "space_2", spaceName: "Second" },
    ];

    setLocationSearch("?q=alpha");
    const container = mount();
    await settle();
    expect(container.textContent).toContain("Results in other Spaces");

    const next = [...container.querySelectorAll("button")].find((b) =>
      /Next/.test(b.textContent ?? ""),
    ) as HTMLButtonElement;
    next.click();
    await settle();

    // Page two is deeper into this space's own results; a hint the reader has
    // already scrolled past belongs to page one only.
    expect(container.textContent).not.toContain("Results in other Spaces");
  });

  it("keeps the field usable while a search is in flight", async () => {
    searchResponse = () => new Promise(() => {});

    const container = mount();
    await settle();

    submit(container, "alpha");
    await settle();

    const input = container.querySelector("input[type=text]") as HTMLInputElement;
    expect(input.disabled).toBe(false);
  });
});
