import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DatabaseDocumentView,
  type DatabaseExtensionView,
} from "#components/DatabaseDocumentView.tsx";

/**
 * The open tab is client-only state, so it has to survive a reload without the
 * server knowing about it — and the restore has to outlast an empty first render:
 * `props.views` arrives from a query, so a stored extension view is not selectable
 * at mount. Selecting it early hit the "extension disappeared" fallback and
 * bounced straight back to Table, which is what these tests pin down.
 */

vi.mock("#components/DatabaseView.tsx", () => ({
  DatabaseView: () => <p>table panel</p>,
}));

vi.mock("#components/ExtensionView.tsx", () => ({
  ExtensionView: () => <p>extension panel</p>,
}));

vi.mock("#composeables/useToast.ts", () => ({
  useToast: () => ({ error: () => {}, success: () => {} }),
}));

vi.mock("#api/client.ts", () => ({
  api: { document: { patch: async () => ({}) } },
}));

const DOCUMENT_ID = "doc_1";
const STORAGE_KEY = `database-view:${DOCUMENT_ID}`;
const BOARD_VIEW_ID = "ext_1:/board";

const boardView: DatabaseExtensionView = {
  extensionId: "ext_1",
  extensionName: "Board",
  route: { path: "/board", title: "Board" } as DatabaseExtensionView["route"],
};

let dispose: (() => void) | undefined;
let host: HTMLElement | undefined;

function mount(views: () => DatabaseExtensionView[]) {
  host = document.createElement("div");
  document.body.append(host);
  dispose = render(
    () => (
      <DatabaseDocumentView
        databaseDocumentId={DOCUMENT_ID}
        spaceId="space_1"
        views={views()}
        viewConfig={JSON.stringify({ viewIds: [BOARD_VIEW_ID] })}
      />
    ),
    host,
  );
  return host;
}

function selectedTab(root: HTMLElement) {
  return root.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim();
}

function panel(root: HTMLElement) {
  return root.querySelector('[role="tabpanel"]')?.textContent?.trim();
}

/** Past `onMount`, the signal writes it makes, and the renders those trigger. */
async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => localStorage.clear());

afterEach(() => {
  dispose?.();
  host?.remove();
  dispose = undefined;
  host = undefined;
});

describe("database view tab persistence", () => {
  it("starts on Table when nothing is stored", async () => {
    const root = mount(() => [boardView]);
    await settle();

    expect(selectedTab(root)).toBe("Table");
    expect(panel(root)).toBe("table panel");
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("stores the tab the user picks", async () => {
    const root = mount(() => [boardView]);
    await settle();

    root.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]?.click();
    await settle();

    expect(selectedTab(root)).toBe("Board");
    expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(BOARD_VIEW_ID));
  });

  it("restores a stored extension view on the next mount", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(BOARD_VIEW_ID));

    const root = mount(() => [boardView]);
    await settle();

    expect(selectedTab(root)).toBe("Board");
    expect(panel(root)).toBe("extension panel");
  });

  it("restores once the views query resolves after mount", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(BOARD_VIEW_ID));
    const [views, setViews] = createSignal<DatabaseExtensionView[]>([]);

    const root = mount(views);
    await settle();
    // The stored view does not exist yet, so Table holds the selection.
    expect(selectedTab(root)).toBe("Table");

    setViews([boardView]);
    await settle();

    expect(selectedTab(root)).toBe("Board");
    expect(panel(root)).toBe("extension panel");
  });

  it("stays on Table when the stored view is gone for good", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("ext_removed:/gone"));

    const root = mount(() => [boardView]);
    await settle();

    expect(selectedTab(root)).toBe("Table");
    expect(panel(root)).toBe("table panel");
  });
});
