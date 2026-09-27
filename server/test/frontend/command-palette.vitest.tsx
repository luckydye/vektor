import { fireEvent } from "@testing-library/dom";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The palette's "create with title" row: the query that matches nothing is
 * exactly the title of the document that does not exist yet, so this row has to
 * survive an empty filter — every other row is filter output.
 */

const navigate = vi.fn();
const [documents, setDocuments] = createSignal<Array<Record<string, unknown>>>([]);

vi.mock("@solidjs/router", () => ({ useNavigate: () => navigate }));
vi.mock("#composeables/useDocuments.ts", () => ({ useDocuments: () => ({ documents }) }));
vi.mock("#composeables/useSpace.ts", () => ({
  useSpace: () => ({
    currentSpace: () => ({ id: "space_1", slug: "first", name: "First" }),
  }),
}));
vi.mock("#utils/history.ts", () => ({
  history: { getAll: async () => [], log: async () => {} },
}));

const { CommandPalatte } = await import("#components/CommandPalatte.tsx");
const { Actions } = await import("#utils/actions.ts");

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  setDocuments([]);
  navigate.mockClear();
  for (const [id] of [...Actions.entries()]) Actions.unregister(id);
});

/** Mounted and opened: a closed palette deliberately renders no rows at all. */
function mountPalette(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const unmount = render(() => (<CommandPalatte />) as JSX.Element, container);
  disposers.push(() => {
    unmount();
    container.remove();
  });
  Actions.run("ui:toggle:palatte");
  return container;
}

/**
 * Row labels in display order, section headings excluded. Keyed on the label's
 * own class: the first `span` in a row is the icon.
 */
function rowLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-result-index]")].map(
    (row) => row.querySelector("span.truncate")?.textContent ?? "",
  );
}

function type(container: HTMLElement, value: string) {
  const input = container.querySelector("input") as HTMLInputElement;
  return fireEvent.input(input, { target: { value } });
}

function pressEnter(container: HTMLElement) {
  return fireEvent.keyDown(container.querySelector("input") as HTMLInputElement, {
    key: "Enter",
  });
}

/** Clicks the row whose label starts with `prefix`. */
function clickRow(container: HTMLElement, prefix: string) {
  const row = [...container.querySelectorAll("[data-result-index]")].find((candidate) =>
    candidate.querySelector("span.truncate")?.textContent?.startsWith(prefix),
  );
  if (!row) throw new Error(`No row labelled "${prefix}…" in ${rowLabels(container)}`);
  return fireEvent.click(row);
}

describe("command palette create-with-title", () => {
  it("offers the typed text as a title when nothing else matches", async () => {
    const container = mountPalette();

    await type(container, "Release notes");

    expect(rowLabels(container)).toEqual([
      'Search "Release notes" in First',
      'Create Document with title "Release notes"',
    ]);
    expect(container.textContent).not.toContain("No results found");
  });

  it("navigates to a seeded draft rather than creating the document", async () => {
    const container = mountPalette();

    await type(container, "Q3 / roadmap");
    await clickRow(container, "Create Document");

    expect(navigate).toHaveBeenCalledWith("/new?title=Q3%20%2F%20roadmap");
  });

  it("keeps the row last so a matching document still wins Enter", async () => {
    setDocuments([{ id: "doc_1", slug: "notes", properties: { title: "Notes" } }]);
    const container = mountPalette();

    await type(container, "Notes");

    expect(rowLabels(container)).toEqual([
      "Notes",
      'Search "Notes" in First',
      'Create Document with title "Notes"',
    ]);

    await pressEnter(container);
    expect(navigate).toHaveBeenCalledWith("/doc/notes");
  });

  it("is absent while the query is empty", async () => {
    const container = mountPalette();

    await type(container, "  ");

    expect(rowLabels(container)).toEqual([]);
    expect(container.textContent).toContain("No results found");
  });

  it("uses the text as typed, not the lowercased filter", async () => {
    const container = mountPalette();

    await type(container, "  API Reference  ");

    expect(rowLabels(container)).toEqual([
      'Search "API Reference" in First',
      'Create Document with title "API Reference"',
    ]);
  });
});

/**
 * The palette filters cached titles and slugs; the search page runs the
 * server-side index over document bodies. This row is the handoff between them.
 */
describe("command palette search-in-space", () => {
  it("hands the typed query to the search page", async () => {
    const container = mountPalette();

    await type(container, "quarterly plan");
    await clickRow(container, "Search");

    expect(navigate).toHaveBeenCalledWith("/search?q=quarterly%20plan");
  });

  /**
   * Nothing matched by title, so the body-text search is the better guess than
   * a new document named after the query.
   */
  it("wins Enter over the create row when no document matches", async () => {
    const container = mountPalette();

    await type(container, "quarterly plan");
    await pressEnter(container);

    expect(navigate).toHaveBeenCalledWith("/search?q=quarterly%20plan");
  });

  it("is absent while the query is empty", async () => {
    const container = mountPalette();

    await type(container, "   ");

    expect(rowLabels(container)).toEqual([]);
  });

  it("sits behind matching documents so it never steals Enter", async () => {
    setDocuments([{ id: "doc_1", slug: "plan", properties: { title: "Plan" } }]);
    const container = mountPalette();

    await type(container, "Plan");
    await pressEnter(container);

    expect(navigate).toHaveBeenCalledWith("/doc/plan");
  });
});

/**
 * The palette stays mounted for its keyboard shortcut, so its list is what the
 * document cache re-renders on every write. Both of these bound that cost.
 */
describe("command palette list size", () => {
  const manyDocuments = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `doc_${index}`,
      slug: `doc-${index}`,
      properties: { title: `Doc ${index}` },
    }));

  it("renders nothing while closed", () => {
    setDocuments(manyDocuments(30));

    const container = document.createElement("div");
    document.body.append(container);
    const unmount = render(() => (<CommandPalatte />) as JSX.Element, container);
    disposers.push(() => {
      unmount();
      container.remove();
    });

    expect(rowLabels(container)).toEqual([]);
  });

  it("caps the documents it lists", () => {
    setDocuments(manyDocuments(120));

    const container = mountPalette();

    expect(rowLabels(container)).toHaveLength(50);
  });

  it("filters the whole space before capping, so search reaches past the cap", async () => {
    setDocuments(manyDocuments(120));

    const container = mountPalette();
    await type(container, "Doc 117");

    expect(rowLabels(container)).toEqual([
      "Doc 117",
      'Search "Doc 117" in First',
      'Create Document with title "Doc 117"',
    ]);
  });
});

/**
 * `page-target` reads the document off its attributes, and a spread through
 * `Dynamic` lands on a custom element as properties instead — so the assertion
 * is on `getAttribute`, not on the props being passed.
 */
describe("command palette drag source", () => {
  const seedOne = () =>
    setDocuments([
      { id: "doc_1", slug: "notes", type: "page", properties: { title: "Notes" } },
    ]);

  it("gives each document row the attributes page-target drags with", () => {
    seedOne();
    const container = mountPalette();

    const row = container.querySelector("page-target");
    expect(row?.getAttribute("data-document-id")).toBe("doc_1");
    expect(row?.getAttribute("data-document-type")).toBe("page");
    expect(row?.getAttribute("data-space-id")).toBe("space_1");
    expect(row?.getAttribute("data-document-url")).toBe("/first/doc/notes");
  });

  /**
   * Hiding the drag source from within `dragstart` cancels the drag before the
   * browser has taken it over, so the palette waits for the first `drag` — by
   * which point the drag survives losing its source.
   */
  it("stays open through dragstart and closes once the drag runs", () => {
    seedOne();
    const container = mountPalette();
    const row = container.querySelector("page-target") as HTMLElement;
    const isOpen = () => !container.querySelector("a-blur")?.hasAttribute("hidden");

    row.dispatchEvent(new Event("dragstart", { bubbles: true }));
    expect(isOpen()).toBe(true);

    row.dispatchEvent(new Event("drag", { bubbles: true }));
    expect(isOpen()).toBe(false);
  });
});
