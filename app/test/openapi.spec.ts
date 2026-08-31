/**
 * The OpenAPI document is generated from the route registry and the doc
 * comment above each handler (see `#api/openapi/comments.ts`), so the thing
 * worth testing is that the two cannot drift: a route with no doc comment, a
 * handler documented for a method it doesn't serve, or a served method with no
 * doc comment, fails here rather than shipping a schema that describes a
 * server nobody is running.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildOpenApiDocument, servesMethod, toOpenApiPath } from "#api/openapi/document.ts";
import { loadRouteDocs } from "#api/openapi/discover.ts";
import { apiRoutes } from "#api/routes.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7571;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

const HTTP_METHODS = ["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH"] as const;

// Read live from each route file's own doc comments — the same thing the dev
// server does on every process start. There is no static table to import.
const routeDocs = await loadRouteDocs();
const document = buildOpenApiDocument(apiRoutes, routeDocs);

describe("OpenAPI document", () => {
  it("documents every registered route", () => {
    const undocumented = apiRoutes
      .map(({ pattern }) => pattern)
      .filter((pattern) => !routeDocs[pattern]);
    expect(undocumented).toEqual([]);
  });

  it("documents no route the server does not serve", () => {
    const patterns = new Set(apiRoutes.map(({ pattern }) => pattern));
    expect(Object.keys(routeDocs).filter((p) => !patterns.has(p))).toEqual([]);
  });

  it("only describes methods the route module answers", () => {
    const unserved: string[] = [];
    for (const { pattern, module } of apiRoutes) {
      for (const method of Object.keys(routeDocs[pattern]?.operations ?? {})) {
        if (!servesMethod(module, method)) unserved.push(`${method} ${pattern}`);
      }
    }
    expect(unserved).toEqual([]);
  });

  it("documents every method a route module answers, unless it exports ALL", () => {
    // An `ALL`-exporting handler (CalDAV, git smart HTTP, better-auth) answers
    // methods OpenAPI cannot describe by design — see `comments.ts` — so it
    // only has to document a subset, not all of them.
    const undocumented: string[] = [];
    for (const { pattern, module } of apiRoutes) {
      if ("ALL" in module) continue;
      const documented = new Set(Object.keys(routeDocs[pattern]?.operations ?? {}));
      for (const method of HTTP_METHODS) {
        if (method in module && !documented.has(method)) {
          undocumented.push(`${method} ${pattern}`);
        }
      }
    }
    expect(undocumented).toEqual([]);
  });

  it("emits an operation for every documented route", () => {
    const missing = Object.keys(routeDocs).filter(
      (pattern) => !document.paths[toOpenApiPath(pattern)],
    );
    expect(missing).toEqual([]);
  });

  it("templates path parameters", () => {
    for (const path of Object.keys(document.paths)) {
      expect(path).not.toMatch(/[[\]]/);
    }
    expect(document.paths["/api/v1/spaces/{spaceId}/documents/{documentId}"]).toBeTruthy();
  });

  it("gives every operation a unique id, a summary and a tag", () => {
    const tags = new Set(document.tags.map((tag) => tag.name));
    const ids = new Set<string>();

    for (const [path, item] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        if (method === "description") continue;
        const value = operation as Record<string, unknown>;
        expect(value.summary, `${method} ${path}`).toBeTruthy();
        expect(tags).toContain((value.tags as string[])[0]);
        expect(ids.has(value.operationId as string), `${value.operationId}`).toBe(false);
        ids.add(value.operationId as string);
      }
    }
  });

  it("resolves every $ref against its component section", () => {
    const components = document.components as Record<string, Record<string, unknown>>;
    const refs = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string") refs.add(child);
        else walk(child);
      }
    };
    walk(document);

    for (const ref of refs) {
      const [, , section, name] = ref.split("/");
      expect(components[section]?.[name], ref).toBeTruthy();
    }
  });

  it("leaves public routes without a security requirement", () => {
    const openapi = document.paths["/api/v1/openapi.json"].get as Record<string, unknown>;
    expect(openapi.security).toEqual([]);

    const spaces = document.paths["/api/v1/spaces"].get as Record<string, unknown>;
    expect(spaces.security).toEqual(document.security);
  });
});

describe("GET /api/v1/openapi.json", () => {
  let serverProcess: TestServerProcess;

  beforeAll(async () => {
    // Real auth, deliberately: the point of the assertion below is that a
    // caller with no credentials at all is served the schema.
    serverProcess = startTestServer(PORT, {
      VEKTOR_IN_MEMORY_DB: "1",
      VEKTOR_EMAIL_AUTH: "1",
      VEKTOR_API_ONLY: "1",
      AUTH_SECRET: process.env.AUTH_SECRET ?? "openapi-test-secret-do-not-use",
    });
    await waitForServer(BASE_URL);
  });

  afterAll(() => {
    serverProcess?.kill();
  });

  it("serves the schema to an unauthenticated caller", async () => {
    const response = await apiRequest("/api/v1/openapi.json");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");

    const body = await response.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.title).toBe("Vektor API");
    expect(Object.keys(body.paths).length).toBe(Object.keys(document.paths).length);
  });
});
