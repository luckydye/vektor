import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Opening a revision from a link. The panel reads the query once, but the space
 * it needs resolves asynchronously after mount — a restore that gives up before
 * that lands never happens at all, and the document renders as if the link
 * carried nothing.
 */

const [spaceId, setSpaceId] = createSignal<string | null>(null);
const navigate = vi.fn();

vi.mock("@solidjs/router", () => ({
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: "/space/doc", search: window.location.search }),
}));
vi.mock("#composeables/useSpace.ts", () => ({
  useSpace: () => ({ currentSpaceId: spaceId, currentSpace: () => undefined }),
}));
vi.mock("#composeables/useRevisions.ts", () => ({
  useRevisions: () => ({
    revisions: () => [],
    getRevision: async (rev: number) => ({ rev, content: "<p>x</p>", status: null }),
    publishRevision: async () => true,
    fetchHistory: async () => {},
    isLoading: () => false,
  }),
}));
vi.mock("#composeables/useAuditLogs.ts", () => ({
  useAuditLogs: () => ({
    auditLogs: () => [],
    isLoading: () => false,
    isFetching: () => false,
    error: () => null,
    fetchAuditLogs: async () => {},
    hasPrevPage: () => false,
    hasNextPage: () => false,
    nextPage: () => {},
    prevPage: () => {},
  }),
}));
vi.mock("#composeables/useDockedWindows.ts", () => ({
  useDockedWindows: () => ({ toggle: () => {}, windows: () => new Map() }),
}));
vi.mock("#composeables/useMembers.ts", () => ({
  useMembers: () => ({ members: () => [] }),
}));
vi.mock("#composeables/useSync.ts", () => ({ useSync: () => {} }));
vi.mock("#components/DockedPanel.tsx", () => ({
  DockedPanel: (props: { children?: JSX.Element }) => props.children,
}));

const { RevisionsSidebar } = await import("#components/RevisionsSidebar.tsx");

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  setSpaceId(null);
  navigate.mockClear();
});

/** Mounts the panel with `search` in the URL, resolving the space afterwards. */
function mountWith(search: string) {
  window.history.replaceState({}, "", `/space/doc${search}`);
  const container = document.createElement("div");
  document.body.append(container);
  const unmount = render(
    () => (<RevisionsSidebar documentId="doc_1" />) as JSX.Element,
    container,
  );
  disposers.push(() => {
    unmount();
    container.remove();
  });
}

/** Resolves after the panel's revision fetch has had a turn to dispatch. */
function nextEvent(type: string): Promise<CustomEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener(type, handler);
      reject(new Error(`no ${type} event`));
    }, 500);
    const handler = (event: Event) => {
      clearTimeout(timer);
      window.removeEventListener(type, handler);
      resolve(event as CustomEvent);
    };
    window.addEventListener(type, handler);
  });
}

describe("revision URL restore", () => {
  it("opens the redline against the base revision from the URL", async () => {
    const diff = nextEvent("revision:diff");
    mountWith("?revision=7&base=3");
    // The space is only known after the panel has mounted.
    setSpaceId("space_1");

    expect((await diff).detail).toMatchObject({ revision: 7, base: 3 });
  });

  it("opens the plain revision when no base rides along", async () => {
    const view = nextEvent("revision:view");
    mountWith("?revision=7");
    setSpaceId("space_1");

    expect((await view).detail).toMatchObject({ revision: 7 });
  });
});
