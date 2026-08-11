import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { describe, expect, it, vi } from "vitest";

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

describe("palette drag", () => {
  it("closes on document-drag-start", async () => {
    setDocuments([{ id: "doc_1", slug: "notes", properties: { title: "Notes" } }]);
    const container = document.createElement("div");
    document.body.append(container);
    render(() => (<CommandPalatte />) as JSX.Element, container);
    Actions.run("ui:toggle:palatte");
    await Promise.resolve();

    const row = container.querySelector("page-target");
    console.log("row tag:", row?.tagName, "count", container.querySelectorAll("page-target").length);
    row?.dispatchEvent(
      new CustomEvent("document-drag-start", {
        bubbles: true,
        composed: true,
        detail: { documentId: "doc_1", documentType: null },
      }),
    );
    await Promise.resolve();
    const blur = container.querySelector("a-blur");
    console.log("blur outer:", blur?.outerHTML.slice(0, 200));
    expect(blur?.hasAttribute("hidden")).toBe(true);
  });
});
