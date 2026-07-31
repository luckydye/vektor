import { MemoryRouter, Route } from "@solidjs/router";
import { render } from "solid-js/web";
import { QueryClient, QueryClientContext } from "#composeables/query.solid.ts";
import { SsrUrlContext } from "#composeables/useRoute.solid.ts";
import { ActiveSpaceIdContext } from "#composeables/useSpace.solid.ts";
import { normalizeDom } from "./normalize.ts";

/**
 * Renders a route view with fixed API responses, for tier 2 snapshots.
 *
 * Route views read their data through composables that fetch, so the fixture is
 * installed as a `fetch` stub rather than by mocking each composable — that way
 * the snapshot exercises the same query, cache and render path the browser
 * does, and a change in how a view asks for its data shows up.
 */

/**
 * Request pattern to response body. Patterns are tested in order and the first
 * match wins, so the specific ones must come first — `/spaces` alone would
 * otherwise swallow `/spaces/:id/documents`.
 */
export type Fixture = Array<[RegExp, unknown]>;

const SPACE = {
  id: "space_fixture",
  name: "Fixture Space",
  slug: "fixture",
  createdBy: "local",
  userRole: "owner",
  memberCount: 1,
  preferences: { brandColor: "#1e293b", workflowCreationEnabled: "true" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** Enough of the API for a route to render its loaded, non-empty state. */
export const BASE_FIXTURE: Fixture = [
  [
    /\/audit-logs/,
    {
      auditLogs: [
        {
          id: 2,
          docId: "doc_fixture_1",
          revisionId: 1,
          userId: "user_ada",
          event: "publish",
          details: { message: "Published revision 1" },
          createdAt: "2026-01-02T10:00:00.000Z",
        },
        {
          id: 1,
          docId: "doc_fixture_1",
          revisionId: null,
          userId: "user_ada",
          event: "create",
          details: {},
          createdAt: "2026-01-02T09:00:00.000Z",
        },
      ],
    },
  ],
  [
    /\/members/,
    [
      {
        spaceId: SPACE.id,
        userId: "user_ada",
        role: "owner",
        user: { id: "user_ada", name: "Ada Lovelace", email: "ada@example.com" },
      },
    ],
  ],
  [/\/categories/, [{ id: "cat_notes", name: "Notes", slug: "notes", color: "#4ECDC4" }]],
  [
    /\/documents/,
    {
      documents: [
        {
          id: "doc_fixture_1",
          slug: "getting-started",
          type: "document",
          title: "Getting started",
          currentRev: 1,
          publishedRev: 1,
          properties: {},
          createdBy: "user_ada",
          createdAt: "2026-01-02T09:00:00.000Z",
          updatedAt: "2026-01-02T10:00:00.000Z",
        },
      ],
      nextCursor: null,
    },
  ],
  [/\/extensions/, { extensions: [] }],
  [/\/integrations/, { connections: [] }],
  [/\/notification-preference/, { muted: false }],
  [/\/ai-chat\/sessions/, { sessions: [] }],
  [/\/access-tokens/, { tokens: [] }],
  [/\/secrets/, { secrets: [] }],
  [/\/workflows\/runs/, { runs: [], nextCursor: null }],
  [/\/jobs\/runs/, { runs: [], nextCursor: null }],
  [/\/schedules/, { schedules: [] }],
  [/\/search/, { results: [], nextCursor: null }],
  // Least specific last: every other space-scoped path is matched above.
  [/\/spaces(\?|$)/, [SPACE]],
];

export function installFixture(fixture: Fixture): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : String((input as Request).url ?? input);
    const hit = fixture.find(([pattern]) => pattern.test(url));
    return new Response(JSON.stringify(hit ? hit[1] : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

export interface RenderedRoute {
  container: HTMLElement;
  snapshot(): string;
  cleanup(): void;
}

/**
 * Mounts a view inside the context `SpaceApp` normally provides — the active
 * space id, the SSR url and a query client.
 *
 * `at` adds a `MemoryRouter`. Views that read route params need one, and a
 * single wildcard route means any path resolves; the params a view wants come
 * through `props`, exactly as `SpaceApp`'s route wrappers pass them.
 */
export async function renderRoute(
  View: unknown,
  options: {
    fixture?: Fixture;
    props?: Record<string, unknown>;
    settle?: number;
    /** Router path. Supply this for a view that reads route params. */
    at?: string;
  } = {},
): Promise<RenderedRoute> {
  // Overrides first so a spec's pattern wins over the base one it shadows.
  installFixture([...(options.fixture ?? []), ...BASE_FIXTURE]);

  const container = document.createElement("div");
  document.body.append(container);

  // biome-ignore lint/suspicious/noExplicitAny: views are resolved dynamically.
  const Component = View as any;
  const props = options.props ?? {};
  const queryClient = new QueryClient();

  const dispose = render(
    () => (
      <QueryClientContext.Provider value={queryClient}>
        <ActiveSpaceIdContext.Provider value={() => SPACE.id}>
          <SsrUrlContext.Provider value={`/${SPACE.slug}`}>
            {options.at ? (
              <MemoryRouter>
                <Route path="*" component={() => <Component {...props} />} />
              </MemoryRouter>
            ) : (
              <Component {...props} />
            )}
          </SsrUrlContext.Provider>
        </ActiveSpaceIdContext.Provider>
      </QueryClientContext.Provider>
    ),
    container,
  );

  // Queries resolve over several microtask hops; a snapshot taken too early
  // captures a loading state and is stable but useless.
  for (let i = 0; i < (options.settle ?? 12); i++) {
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return {
    container,
    snapshot: () => normalizeDom(container),
    cleanup() {
      dispose();
      container.remove();
    },
  };
}
