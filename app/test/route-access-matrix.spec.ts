/**
 * Registry-driven access coverage.
 *
 * Every other ACL spec proves that a *chosen* route enforces a *chosen* rule.
 * This one asks the opposite question: given the whole route registry, does any
 * route let a caller through who should not be there? It walks `apiRoutes`, so a
 * route added tomorrow is probed tomorrow — nobody has to remember to add a case.
 *
 * Each route is called by five identities:
 *
 *   anonymous   no credentials at all
 *   outsider    a real account with no grant anywhere in the space
 *   viewer      space-level `viewer`
 *   editor      space-level `editor`
 *   owner       the space creator
 *
 * Every identity gets its own fixture space, so a write that succeeds destroys
 * only that identity's fixture and cannot skew another's results. Within an
 * identity, reads run first and the destructive routes run last (the document,
 * then the space), so earlier probes still see a live fixture.
 *
 * The assertions are deliberately narrow — an outsider must never get a 2xx,
 * and must never see fixture data whatever the status — because "what should an
 * editor reach?" is a judgement call per route. The generated matrix is the
 * artefact for that judgement: `test/output/route-access.md` to read, and
 * `route-access.csv` (one row per route × method × identity) to filter in a
 * spreadsheet.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRoutes } from "#api/routes.ts";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7492;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createSessionApiRequest(BASE_URL);
const FIXTURE_TITLE = "Matrix Document";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND", "REPORT"]);
const HTTP_METHODS = [
  "GET",
  "HEAD",
  "OPTIONS",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "PROPFIND",
  "REPORT",
  "MKCALENDAR",
] as const;

/**
 * Routes that are public by design. Each needs a reason, and the list is the
 * thing to argue about in review — everything not on it must reject an outsider.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  "/.well-known/caldav": "service discovery, no space data",
  "/.well-known/vektor": "service discovery, no space data",
  "/api/auth/[...all]": "better-auth: sign-in/sign-up must be reachable",
  "/api/v1/auth/cli": "CLI pairing: authenticated by the one-time code it mints",
  "/api/v1/auth/cli/token": "CLI pairing: authenticated by the one-time code",
};

/**
 * Routes scoped to the caller rather than to a space: a 2xx for an outsider is
 * correct because the answer is about *them*. They are still held to the leak
 * assertion below — the response must not mention the fixture space.
 */
const USER_SCOPED_ROUTES: Record<string, string> = {
  "/api/v1/access-tokens": "the caller's own tokens, in the spaces it belongs to",
  "/api/v1/access-tokens/[tokenId]": "reaches only a token the caller issued",
  "/api/v1/search":
    "searches only the spaces the caller can read; empty without a session",
  "/api/v1/spaces": "lists only spaces the caller belongs to",
  "/api/v1/users/me": "the caller's own profile",
  "/api/v1/users/suggestions": "invite suggestions from the caller's own groups",
};

/** Fixture ids for one identity's own space. */
interface Fixture {
  spaceId: string;
  documentId: string;
  categoryId: string;
  tokenId: string;
}

/**
 * Query strings for routes that validate parameters before authorizing. Without
 * them the probe dies in validation with a 400 and never reaches the guard, so
 * the cell would prove nothing about access.
 */
const ROUTE_QUERY: Record<string, (fixture: Fixture) => string> = {
  "/api/v1/spaces/[spaceId]/comments": (f) => `?documentId=${f.documentId}`,
  "/api/v1/spaces/[spaceId]/documents/[documentId]/diff": () => "?rev=1",
  // The scoped form, which is the one every signed-in account may ask. Unscoped
  // it is the instance register, which answers an admin with every account and
  // everyone else with `[]`; no identity here administers the instance, so
  // `user-register.spec.ts` is what probes that form.
  "/api/v1/users": (f) => `?spaceId=${f.spaceId}`,
  // `url-metadata` and `proxy-media` are deliberately absent: satisfying them
  // means handing the server a URL it will actually fetch, and this suite has
  // no business making outbound requests. Their cells stay inconclusive.
};

/**
 * Bodies for write routes that validate shape before authorizing. The chat
 * routes are deliberately absent: a well-formed body there would drive a real
 * model call, which this spec has no business doing.
 */
const ROUTE_BODY: Record<string, (fixture: Fixture) => unknown> = {
  "/api/v1/spaces/[spaceId]": () => ({ name: "Matrix Renamed" }),
  "/api/v1/spaces/[spaceId]/comments": (f) => ({
    documentId: f.documentId,
    body: "matrix probe",
  }),
  "/api/v1/spaces/[spaceId]/permissions": () => ({
    type: "role",
    roleOrFeature: "viewer",
    userId: "matrix-missing-user",
    action: "grant",
  }),
  "/api/v1/spaces/[spaceId]/integrations/[provider]/proxy": () => ({
    path: "/api/v4/user",
  }),
};

/** Identities the matrix is computed for, weakest first. */
type IdentityName = "anonymous" | "outsider" | "viewer" | "editor" | "owner";
const IDENTITIES: IdentityName[] = ["anonymous", "outsider", "viewer", "editor", "owner"];

type Outcome = "allowed" | "denied" | "inconclusive" | "error" | "not-probed";

interface Probe {
  pattern: string;
  method: string;
  results: Record<IdentityName, number | null>;
  /** Response bodies for the identities that must see nothing of the space. */
  outsiderBodies: Partial<Record<"anonymous" | "outsider", string>>;
  /** Params in the pattern that no fixture could fill. */
  unresolved: string[];
}

let serverProcess: TestServerProcess;
let sessions: Record<Exclude<IdentityName, "anonymous">, string>;
let fixtures: Record<IdentityName, Fixture>;
let probes: Probe[] = [];

/**
 * How a status reads as an access verdict. A 400/404/405 means the request died
 * before or beside the guard — it is not evidence of denial, and saying so is
 * the difference between a matrix you can trust and one that flatters itself.
 */
function outcomeOf(status: number | null): Outcome {
  if (status === null) return "not-probed";
  // A 3xx counts as admission: the guard ran, let the caller through, and the
  // handler answered with a destination — which the leak assertion then reads.
  if (status >= 200 && status < 400) return "allowed";
  if (status === 401 || status === 403) return "denied";
  if (status >= 500) return "error";
  return "inconclusive";
}

/** Substitute fixture ids into a bracket pattern; report what could not be filled. */
function buildPath(
  pattern: string,
  fixture: Fixture,
): { path: string; unresolved: string[] } {
  const params: Record<string, string> = {
    spaceId: fixture.spaceId,
    documentId: fixture.documentId,
    id: fixture.categoryId,
    tokenId: fixture.tokenId,
    resourceId: fixture.documentId,
    resourceType: "document",
    userId: "self",
    provider: "gitlab",
    // No fixture exists for these: a well-formed but absent id, so a 404 is
    // expected and only a 2xx would be alarming.
    extensionId: "matrix-missing-extension",
    sessionId: "matrix-missing-session",
    scheduleId: "matrix-missing-schedule",
    runId: "matrix-missing-run",
    eventId: "matrix-missing-event",
    name: "matrix-missing-secret",
    path: "matrix-missing-path",
    all: "session",
  };

  const unresolved: string[] = [];
  const path = pattern.replace(
    /\[\.\.\.([a-zA-Z]+)\]|\[([a-zA-Z]+)\]/g,
    (_m, rest, one) => {
      const name = rest ?? one;
      const value = params[name];
      if (value === undefined) {
        unresolved.push(name);
        return "unresolvable";
      }
      return value;
    },
  );
  return { path: `${path}${ROUTE_QUERY[pattern]?.(fixture) ?? ""}`, unresolved };
}

/**
 * The methods a route module answers. A module may export one handler per
 * method, or a single `ALL` catch-all — the caldav and better-auth routes use
 * the latter, so probing only named exports would skip them entirely.
 */
function methodsOf(module: Record<string, unknown>): string[] {
  const named = HTTP_METHODS.filter((method) => typeof module[method] === "function");
  if (typeof module.ALL === "function") {
    // Representative sample: a read, a write, and the caldav discovery verb.
    for (const method of ["GET", "POST", "PROPFIND"]) {
      if (!named.includes(method as (typeof HTTP_METHODS)[number])) {
        named.push(method as (typeof HTTP_METHODS)[number]);
      }
    }
  }
  return named;
}

/**
 * Probe order within one identity: reads, then writes, then the routes that
 * destroy the fixture — the document last but one, the space last. A successful
 * `DELETE /spaces/:id` early on would turn every later probe for that identity
 * into a 404.
 */
function probeOrder(pattern: string, method: string): number {
  if (READ_METHODS.has(method)) return 0;
  if (method !== "DELETE") return 1;
  if (pattern === "/api/v1/spaces/[spaceId]") return 4;
  if (pattern === "/api/v1/spaces/[spaceId]/documents/[documentId]") return 3;
  return 2;
}

async function probeRoute(
  pattern: string,
  method: string,
  identity: IdentityName,
): Promise<{ status: number; body: string; unresolved: string[] }> {
  const fixture = fixtures[identity];
  const { path, unresolved } = buildPath(pattern, fixture);

  // `manual`, so the cell records what the route answered. Following a redirect
  // records the *target's* status instead — the integrations callback then reads
  // as the space page's 200, and turns red whenever that unrelated render fails.
  const init: RequestInit = { method, redirect: "manual" };
  if (!READ_METHODS.has(method)) {
    init.body = JSON.stringify(ROUTE_BODY[pattern]?.(fixture) ?? {});
  }

  const response =
    identity === "anonymous"
      ? await fetch(`${BASE_URL}${path}`, {
          ...init,
          headers: { "Content-Type": "application/json" },
        })
      : await apiRequest(path, sessions[identity], init);

  // Always drained, so the server can close the connection.
  const body = await response.text().catch(() => "");
  // A redirect carries its ids in `Location` and has no body at all, so the leak
  // assertion has to read the header to see them.
  const location = response.headers.get("location");
  const recorded = location ? `${location}\n${body}` : body;
  return { status: response.status, body: recorded.slice(0, 20_000), unresolved };
}

/** A space with a document, a category and an access token, created by `ownerToken`. */
async function createFixture(ownerToken: string, label: string): Promise<Fixture> {
  const spaceResponse = await apiRequest("/api/v1/spaces", ownerToken, {
    method: "POST",
    body: JSON.stringify({
      name: `Matrix ${label}`,
      slug: `matrix-${label}-${Date.now()}`,
    }),
  });
  if (!spaceResponse.ok) {
    throw new Error(`Failed to create ${label} space: ${spaceResponse.status}`);
  }
  const spaceId = (await spaceResponse.json()).space.id;

  const documentResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/documents`,
    ownerToken,
    {
      method: "POST",
      body: JSON.stringify({
        content: "# Matrix Document",
        properties: { title: FIXTURE_TITLE, slug: "matrix-document" },
      }),
    },
  );
  const documentId = (await documentResponse.json()).document.id;

  const categoryResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/categories`,
    ownerToken,
    {
      method: "POST",
      body: JSON.stringify({ name: "Matrix Category", slug: "matrix-category" }),
    },
  );
  const categoryId = categoryResponse.ok
    ? ((await categoryResponse.json()).category?.id ?? "matrix-category")
    : "matrix-category";

  const tokenResponse = await apiRequest(
    `/api/v1/spaces/${spaceId}/access-tokens`,
    ownerToken,
    {
      method: "POST",
      body: JSON.stringify({
        name: "matrix-token",
        permission: "viewer",
        resourceType: "space",
        resourceId: spaceId,
      }),
    },
  );
  const tokenId = tokenResponse.ok
    ? ((await tokenResponse.json()).accessToken?.id ?? "matrix-token")
    : "matrix-token";

  return { spaceId, documentId, categoryId, tokenId };
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET ?? "matrix-test-secret-do-not-use",
  });
  await waitForServer(BASE_URL);

  const make = (name: string) => createTestUser(BASE_URL, name, "test-matrix");
  const ownerUser = await make("Matrix Owner");
  const editorUser = await make("Matrix Editor");
  const viewerUser = await make("Matrix Viewer");
  const outsiderUser = await make("Matrix Outsider");

  sessions = {
    owner: ownerUser.token,
    editor: editorUser.token,
    viewer: viewerUser.token,
    outsider: outsiderUser.token,
  };

  // One space per identity. `anonymous` and `outsider` share the space nobody
  // granted them anything on — it is also the space the leak assertion checks,
  // and it survives the run because every write they attempt is rejected.
  const outsiderView = await createFixture(sessions.owner, "outsider");
  const viewerFixture = await createFixture(sessions.owner, "viewer");
  const editorFixture = await createFixture(sessions.owner, "editor");
  const ownerFixture = await createFixture(sessions.owner, "owner");

  for (const [fixture, user, role] of [
    [viewerFixture, viewerUser, "viewer"],
    [editorFixture, editorUser, "editor"],
  ] as const) {
    const granted = await apiRequest(
      `/api/v1/spaces/${fixture.spaceId}/permissions`,
      sessions.owner,
      {
        method: "POST",
        body: JSON.stringify({
          type: "role",
          roleOrFeature: role,
          userId: user.userId,
          action: "grant",
        }),
      },
    );
    if (!granted.ok) throw new Error(`Failed to grant ${role}: ${granted.status}`);
  }

  fixtures = {
    anonymous: outsiderView,
    outsider: outsiderView,
    viewer: viewerFixture,
    editor: editorFixture,
    owner: ownerFixture,
  };

  const pairs = apiRoutes.flatMap((route) =>
    methodsOf(route.module as Record<string, unknown>).map((method) => ({
      pattern: route.pattern,
      method,
    })),
  );

  const collected = new Map<string, Probe>();
  for (const { pattern, method } of pairs) {
    collected.set(`${pattern} ${method}`, {
      pattern,
      method,
      results: {
        anonymous: null,
        outsider: null,
        viewer: null,
        editor: null,
        owner: null,
      },
      outsiderBodies: {},
      unresolved: [],
    });
  }

  // Identity-major, so each identity's destructive routes run last against its
  // own fixture.
  const ordered = [...pairs].sort(
    (a, b) =>
      probeOrder(a.pattern, a.method) - probeOrder(b.pattern, b.method) ||
      a.pattern.localeCompare(b.pattern),
  );

  for (const identity of IDENTITIES) {
    for (const { pattern, method } of ordered) {
      const probe = collected.get(`${pattern} ${method}`);
      if (!probe) continue;
      const { status, body, unresolved } = await probeRoute(pattern, method, identity);
      probe.results[identity] = status;
      probe.unresolved = unresolved;
      if (identity === "anonymous" || identity === "outsider") {
        probe.outsiderBodies[identity] = body;
      }
    }
  }

  probes = [...collected.values()];
}, 300_000);

afterAll(() => {
  serverProcess?.kill();
});

function cell(status: number | null): string {
  if (status === null) return "-";
  return String(status);
}

function noteFor(probe: Probe): string {
  const notes: string[] = [];
  if (probe.pattern in PUBLIC_ROUTES) {
    notes.push(`public — ${PUBLIC_ROUTES[probe.pattern]}`);
  }
  if (probe.pattern in USER_SCOPED_ROUTES) {
    notes.push(`caller-scoped — ${USER_SCOPED_ROUTES[probe.pattern]}`);
  }
  if (probe.unresolved.length > 0) {
    notes.push(`no fixture for ${probe.unresolved.join(", ")}`);
  }
  return notes.join("; ");
}

/** How a route is classified for review, mirroring the allowlists above. */
function scopeOf(probe: Probe): string {
  if (probe.pattern in PUBLIC_ROUTES) return "public";
  if (probe.pattern in USER_SCOPED_ROUTES) return "caller-scoped";
  return "space-scoped";
}

/** The matrix as a markdown table, restricted to `identities` columns. */
function renderTable(rows: Probe[], identities: IdentityName[]): string[] {
  return [
    `| Route | Method | ${identities.join(" | ")} | notes |`,
    `| --- | --- | ${identities.map(() => "---").join(" | ")} | --- |`,
    ...rows.map(
      (probe) =>
        `| \`${probe.pattern}\` | ${probe.method} | ${identities
          .map((identity) => cell(probe.results[identity]))
          .join(" | ")} | ${noteFor(probe)} |`,
    ),
  ];
}

/**
 * One row per route × method × identity — the shape a spreadsheet wants. "What
 * does a viewer get a 200 for" is then filter `identity = viewer`,
 * `outcome = allowed`, and pivots work without reshaping.
 */
function renderCsv(rows: Probe[]): string {
  const quoteCell = (value: string): string =>
    /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const header = ["route", "method", "identity", "status", "outcome", "scope", "note"];
  const body = rows.flatMap((probe) =>
    IDENTITIES.map((identity) =>
      [
        probe.pattern,
        probe.method,
        identity,
        probe.results[identity] === null ? "" : String(probe.results[identity]),
        outcomeOf(probe.results[identity]),
        scopeOf(probe),
        noteFor(probe),
      ]
        .map(quoteCell)
        .join(","),
    ),
  );

  return [header.join(","), ...body].join("\n");
}

/** Stable row order, so the snapshot below diffs by cell rather than by shuffle. */
function sortedProbes(): Probe[] {
  return [...probes].sort(
    (a, b) => a.pattern.localeCompare(b.pattern) || a.method.localeCompare(b.method),
  );
}

describe("route access matrix", () => {
  it("probes every route in the registry", () => {
    expect(probes.length).toBeGreaterThan(0);
    const patterns = new Set(probes.map((probe) => probe.pattern));
    const withHandlers = apiRoutes.filter(
      (route) => methodsOf(route.module as Record<string, unknown>).length > 0,
    );
    expect(patterns.size).toBe(withHandlers.length);
  });

  it("probes every identity against every route", () => {
    const gaps = probes
      .filter((probe) => IDENTITIES.some((identity) => probe.results[identity] === null))
      .map((probe) => `${probe.method} ${probe.pattern}`);

    expect(gaps).toEqual([]);
  });

  /** Space-scoped: not public, not about the caller themselves. */
  function spaceScoped(probe: Probe): boolean {
    return !(probe.pattern in PUBLIC_ROUTES) && !(probe.pattern in USER_SCOPED_ROUTES);
  }

  for (const identity of ["anonymous", "outsider"] as const) {
    it(`never admits ${identity} to a space-scoped route`, () => {
      const admitted = probes
        .filter(spaceScoped)
        // OPTIONS is discovery: it answers 204 with no body, and the leak
        // assertion below still covers whatever it does return.
        .filter((probe) => probe.method !== "OPTIONS")
        .filter((probe) => outcomeOf(probe.results[identity]) === "allowed")
        .map((probe) => `${probe.method} ${probe.pattern} → ${probe.results[identity]}`);

      expect(admitted).toEqual([]);
    });

    it(`never leaks fixture-space data to ${identity}, whatever the status`, () => {
      const secrets = [
        { name: "spaceId", value: fixtures[identity].spaceId },
        { name: "documentId", value: fixtures[identity].documentId },
        { name: "document title", value: FIXTURE_TITLE },
      ];

      const leaks = probes
        .flatMap((probe) => {
          const body = probe.outsiderBodies[identity] ?? "";
          return secrets
            .filter((secret) => secret.value && body.includes(secret.value))
            .map(
              (secret) =>
                `${probe.method} ${probe.pattern} → ${probe.results[identity]} leaked ${secret.name}`,
            );
        })
        .sort();

      expect(leaks).toEqual([]);
    });
  }

  // The matrix carries a space in the path and so cannot probe this route: it
  // takes its space from an `X-Space-Id` header, which is exactly how a session
  // alone once bought a stranger the use of that space's AI provider. The guard
  // runs before the body is parsed and before the provider is loaded, so a
  // rejected caller here never reaches a model.
  for (const identity of ["anonymous", "outsider"] as const) {
    it(`denies chat completions to ${identity} naming a space by header`, async () => {
      const path = "/api/v1/chat/completions";
      const headers = { "X-Space-Id": fixtures.outsider.spaceId };
      const init: RequestInit = { method: "POST", body: "{}", headers };

      const response =
        identity === "anonymous"
          ? await fetch(`${BASE_URL}${path}`, {
              ...init,
              headers: { ...headers, "Content-Type": "application/json" },
            })
          : await apiRequest(path, sessions.outsider, init);
      await response.text().catch(() => "");

      expect(outcomeOf(response.status)).toBe("denied");
    });
  }

  it("answers every caller with a verdict, not a crash", () => {
    // A 5xx is never an access verdict: for an outsider it hides whether the
    // guard ran, and for a member it is a bug reached through an open door.
    const crashes = probes
      .flatMap((probe) =>
        IDENTITIES.filter(
          (identity) => outcomeOf(probe.results[identity]) === "error",
        ).map(
          (identity) =>
            `${probe.method} ${probe.pattern} → ${identity} ${probe.results[identity]}`,
        ),
      )
      .sort();

    expect(crashes).toEqual([]);
  });

  /**
   * The invariants above only catch a cell turning *permissive*. This catches any
   * cell moving at all — including a 403 becoming a 400, which means validation
   * overtook the guard and the cell stopped proving anything. The generated files
   * under `test/output/` cannot serve: they are gitignored, so drift in them is
   * invisible. Run vitest with `-u` to accept an intended change.
   */
  it("matches the committed access matrix", async () => {
    const table = renderTable(sortedProbes(), IDENTITIES).join("\n");

    await expect(`${table}\n`).toMatchFileSnapshot("snapshots/route-access.md");
  });

  it("writes the access matrix", () => {
    const rows = sortedProbes();

    const inconclusive = rows.flatMap((probe) =>
      IDENTITIES.filter(
        (identity) => outcomeOf(probe.results[identity]) === "inconclusive",
      ),
    ).length;

    const summary = [
      `Probed ${rows.length} route/method pairs across ${new Set(rows.map((row) => row.pattern)).size} routes;`,
      `${rows.length * IDENTITIES.length} cells, ${inconclusive} inconclusive`,
      "(the request died beside the guard, so the cell proves nothing about access).",
    ].join(" ");

    const markdown = [
      "# Route access matrix",
      "",
      "Generated by `test/route-access-matrix.spec.ts`. HTTP status per caller.",
      "",
      ...renderTable(rows, IDENTITIES),
      "",
      summary,
      "",
    ].join("\n");

    const outputDir = join(process.cwd(), "test/output");
    mkdirSync(outputDir, { recursive: true });
    const markdownPath = join(outputDir, "route-access.md");
    const csvPath = join(outputDir, "route-access.csv");
    writeFileSync(markdownPath, markdown);
    writeFileSync(csvPath, `${renderCsv(rows)}\n`);

    // The files are the artefact; printing every row on each run is noise.
    console.log(
      [
        "",
        summary,
        `  markdown: ${markdownPath}`,
        `  csv:      ${csvPath}  (one row per route × method × identity)`,
        "",
      ].join("\n"),
    );

    expect(rows.length).toBeGreaterThan(0);
  });
});
