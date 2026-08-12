/**
 * Property keys that collide with `Object.prototype`.
 *
 * A document property named `constructor` used to 500 `GET /properties` for the
 * whole space — the aggregation used a plain object as a map, so
 * `map["constructor"]` came back as the inherited `Object` constructor, the
 * truthiness guard treated it as an existing entry, and the initializer was
 * skipped. Nothing in the space could remove the row again, which made it a
 * persistent denial of service of the property panel, the filters and the
 * database-view columns.
 *
 * The aggregation half is tested directly against the pure function; the write
 * and listing halves go through a real server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  aggregateStoredProperties,
  isReservedDocumentPropertyKey,
  readDocumentProperty,
} from "#documents/properties.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

/** Every `Object.prototype` member a property key can shadow. */
const PROTOTYPE_KEYS = [
  "constructor",
  "__proto__",
  "toString",
  "hasOwnProperty",
  "valueOf",
] as const;

/** The subset that corrupts an object on write, so the API refuses to store it. */
const RESERVED_KEYS = ["__proto__", "constructor", "prototype"] as const;

/** Colliding keys that are legitimate names and must keep working end to end. */
const ALLOWED_COLLIDING_KEYS = ["toString", "hasOwnProperty", "valueOf"] as const;

// ---------------------------------------------------------------------------
// The aggregation itself — no database, no server
// ---------------------------------------------------------------------------

describe("aggregateStoredProperties", () => {
  it.each(PROTOTYPE_KEYS)("aggregates a property named %s instead of throwing", (key) => {
    const properties = aggregateStoredProperties([
      { key, value: "alpha", type: "select" },
      { key, value: "beta", type: null },
      { key: "title", value: "A document", type: null },
    ]);

    const entry = properties.find((property) => property.name === key);
    expect(entry).toBeDefined();
    expect(entry?.values).toEqual(["alpha", "beta"]);
    // The type is taken from the first row that carries one.
    expect(entry?.type).toBe("select");
  });

  it("aggregates every colliding key in one pass", () => {
    const properties = aggregateStoredProperties(
      PROTOTYPE_KEYS.map((key) => ({ key, value: `value-of-${key}`, type: null })),
    );

    expect(properties.map((property) => property.name).sort()).toEqual(
      [...PROTOTYPE_KEYS].sort(),
    );
    for (const key of PROTOTYPE_KEYS) {
      const entry = properties.find((property) => property.name === key);
      expect(entry?.values).toEqual([`value-of-${key}`]);
    }
  });

  it("dedupes and sorts values, and unpacks multi-value rows", () => {
    const properties = aggregateStoredProperties([
      { key: "toString", value: JSON.stringify(["review", "draft"]), type: null },
      { key: "toString", value: "draft", type: "multi-select" },
      { key: "toString", value: "", type: null },
    ]);

    expect(properties).toHaveLength(1);
    expect(properties[0].values).toEqual(["draft", "review"]);
    expect(properties[0].type).toBe("multi-select");
  });

  it("keeps a `__proto__` key as an ordinary entry rather than a prototype", () => {
    const properties = aggregateStoredProperties([
      { key: "__proto__", value: "not-a-prototype", type: null },
    ]);

    expect(properties).toHaveLength(1);
    expect(properties[0].name).toBe("__proto__");
    expect(properties[0].values).toEqual(["not-a-prototype"]);
  });

  it("returns nothing for no rows", () => {
    expect(aggregateStoredProperties([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Reading a property bag by a key from a request
// ---------------------------------------------------------------------------

describe("readDocumentProperty", () => {
  it.each(PROTOTYPE_KEYS)("returns undefined for an absent %s key", (key) => {
    expect(readDocumentProperty({ title: "A document" }, key)).toBeUndefined();
  });

  it("returns the value when the bag really has the key", () => {
    const bag = JSON.parse('{"toString":"tuesday"}');
    expect(readDocumentProperty(bag, "toString")).toBe("tuesday");
  });
});

describe("isReservedDocumentPropertyKey", () => {
  it.each(RESERVED_KEYS)("reserves %s", (key) => {
    expect(isReservedDocumentPropertyKey(key)).toBe(true);
  });

  it.each(ALLOWED_COLLIDING_KEYS)("allows %s", (key) => {
    expect(isReservedDocumentPropertyKey(key)).toBe(false);
  });

  it("is case sensitive, so ordinary names starting with a capital are allowed", () => {
    expect(isReservedDocumentPropertyKey("Constructor")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The write path and the space-wide listing, against a real server
// ---------------------------------------------------------------------------

const PORT = 7493;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let spaceId: string;

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
  });
  await waitForServer(BASE_URL);

  const response = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({
      name: "Prototype Key Space",
      slug: `prototype-key-space-${Date.now()}`,
    }),
  });
  expect(response.status).toBe(201);
  spaceId = (await response.json()).space.id;
});

afterAll(() => {
  serverProcess?.kill();
});

async function createDocument(properties: Record<string, unknown>): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({ content: "<p>body</p>", properties }),
  });
}

async function listProperties(): Promise<{ name: string; values: string[] }[]> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/properties`);
  expect(response.status).toBe(200);
  return (await response.json()).properties;
}

describe("reserved property keys are refused", () => {
  it.each(RESERVED_KEYS)("rejects %s when creating a document", async (key) => {
    // Built through JSON so `__proto__` arrives as an own property, exactly as it
    // does from a real request body.
    const response = await createDocument(
      JSON.parse(`{"title":"Reserved ${key}","${key}":"value"}`),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(key);
  });

  it.each(RESERVED_KEYS)("rejects %s when patching a document", async (key) => {
    const created = await createDocument({ title: `Patch target ${key}` });
    expect(created.status).toBe(201);
    const documentId = (await created.json()).document.id;

    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ properties: JSON.parse(`{"${key}":"value"}`) }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(key);
  });

  it.each(
    RESERVED_KEYS,
  )("still allows deleting %s, so a poisoned document can be cleaned up", async (key) => {
    const created = await createDocument({ title: `Delete target ${key}` });
    expect(created.status).toBe(201);
    const documentId = (await created.json()).document.id;

    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      {
        method: "PATCH",
        body: JSON.stringify({ properties: JSON.parse(`{"${key}":null}`) }),
      },
    );

    expect(response.status).toBe(200);
  });
});

describe("colliding property keys survive the space-wide listing", () => {
  it("accepts every allowed colliding key and lists all of them", async () => {
    const properties: Record<string, string> = { title: "Colliding Keys" };
    for (const key of ALLOWED_COLLIDING_KEYS) {
      properties[key] = `value-of-${key}`;
    }

    const created = await createDocument(properties);
    expect(created.status).toBe(201);

    const listed = await listProperties();
    for (const key of ALLOWED_COLLIDING_KEYS) {
      const entry = listed.find((property) => property.name === key);
      expect(entry, `expected ${key} in the property listing`).toBeDefined();
      expect(entry?.values).toContain(`value-of-${key}`);
    }
  });

  it("keeps listing ordinary properties alongside them", async () => {
    const created = await createDocument({ title: "Ordinary", status: "published" });
    expect(created.status).toBe(201);

    const listed = await listProperties();
    expect(listed.find((property) => property.name === "status")?.values).toContain(
      "published",
    );
    // The virtual `type` property is always present.
    expect(listed.some((property) => property.name === "type")).toBe(true);
  });

  it("drops a deleted document's properties instead of listing them as ghosts", async () => {
    const created = await createDocument({
      title: "Doomed",
      valueOf: "only-on-the-doomed-document",
    });
    expect(created.status).toBe(201);
    const documentId = (await created.json()).document.id;

    const deleted = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}?permanent=true`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);

    // The `property` row outlives the document — deletes do not cascade (audit
    // 022) — so the listing has to exclude it by joining, or the orphan shows up
    // as a property of the space that nothing can explain or remove.
    const listed = await listProperties();
    const valueOfEntry = listed.find((property) => property.name === "valueOf");
    expect(valueOfEntry?.values ?? []).not.toContain("only-on-the-doomed-document");
  });

  it("drops an archived document's properties too", async () => {
    const created = await createDocument({
      title: "Archived",
      toString: "only-on-the-archived-document",
    });
    expect(created.status).toBe(201);
    const documentId = (await created.json()).document.id;

    const archived = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      { method: "DELETE" },
    );
    expect(archived.status).toBe(200);

    const listed = await listProperties();
    const toStringEntry = listed.find((property) => property.name === "toString");
    expect(toStringEntry?.values ?? []).not.toContain("only-on-the-archived-document");
  });
});

describe("search filters over colliding property keys", () => {
  it.each(PROTOTYPE_KEYS)("does not 500 when filtering on %s", async (key) => {
    // A filter key is raw request input, so it reaches the property bag without
    // any document having to carry the key first.
    const filters = encodeURIComponent(JSON.stringify([{ key, value: "anything" }]));
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/search?q=body&filters=${filters}`,
    );

    expect(response.status).toBe(200);
  });

  it.each(PROTOTYPE_KEYS)("does not 500 on an is-empty filter for %s", async (key) => {
    const filters = encodeURIComponent(JSON.stringify([{ key, value: null }]));
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/search?filters=${filters}`,
    );

    expect(response.status).toBe(200);
  });
});

describe("category grouping over colliding slugs", () => {
  it.each(PROTOTYPE_KEYS)("does not 500 when grouping by a %s category", async (key) => {
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents?categorySlugs=${encodeURIComponent(key)}&grouped=true`,
    );

    expect(response.status).toBeLessThan(500);
  });
});
