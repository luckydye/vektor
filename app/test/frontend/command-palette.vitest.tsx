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
  useSpace: () => ({ currentSpace: () => ({ id: "space_1", slug: "first" }) }),
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

function mountPalette(): HTMLElement {
  const container = document.createElement("div");
  document.body.append(container);
  const unmount = render(() => (<CommandPalatte />) as JSX.Element, container);
  disposers.push(() => {
    unmount();
    container.remove();
  });
  return container;
}

/** Row labels in display order, section headings excluded. */
function rowLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-result-index]")].map(
    (row) => row.querySelector("span")?.textContent ?? "",
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

describe("command palette create-with-title", () => {
  it("offers the typed text as a title when nothing else matches", async () => {
    const container = mountPalette();

    await type(container, "Release notes");

    expect(rowLabels(container)).toEqual(['Create Document with title "Release notes"']);
    expect(container.textContent).not.toContain("No results found");
  });

  it("navigates to a seeded draft rather than creating the document", async () => {
    const container = mountPalette();

    await type(container, "Q3 / roadmap");
    await pressEnter(container);

    expect(navigate).toHaveBeenCalledWith("/new?title=Q3%20%2F%20roadmap");
  });

  it("keeps the row last so a matching document still wins Enter", async () => {
    setDocuments([{ id: "doc_1", slug: "notes", properties: { title: "Notes" } }]);
    const container = mountPalette();

    await type(container, "Notes");

    expect(rowLabels(container)).toEqual(["Notes", 'Create Document with title "Notes"']);

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

    expect(rowLabels(container)).toEqual(['Create Document with title "API Reference"']);
  });
});
