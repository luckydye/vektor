import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSpaceStore } from "#db/client/store.ts";
import { property } from "#db/schema/space.ts";
import { deleteSpace } from "#db/space/spaces.ts";
import {
  aggregateStoredProperties,
  canonicalPropertyKey,
  normalizeDocumentPropertyPatch,
  readDocumentProperty,
} from "#documents/properties.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

describe("canonicalPropertyKey", () => {
  it("folds case and surrounding space", () => {
    expect(canonicalPropertyKey("Date")).toBe("date");
    expect(canonicalPropertyKey("  dueDate ")).toBe("duedate");
  });
});

describe("aggregateStoredProperties over mixed spellings", () => {
  it("lists one entry and pools the values of both spellings", () => {
    const properties = aggregateStoredProperties([
      { key: "date", value: "2026-01-01", type: "date" },
      { key: "Date", value: "2026-02-02", type: null },
    ]);

    expect(properties).toHaveLength(1);
    expect(properties[0].values).toEqual(["2026-01-01", "2026-02-02"]);
  });

  it("shows the spelling used by the most documents", () => {
    const properties = aggregateStoredProperties([
      { key: "Date", value: "a", type: null },
      { key: "date", value: "b", type: null },
      { key: "date", value: "c", type: null },
    ]);

    expect(properties[0].name).toBe("date");
  });

  it("breaks a tie the same way on every read", () => {
    const rows = [
      { key: "Date", value: "a", type: null },
      { key: "date", value: "b", type: null },
    ];

    const first = aggregateStoredProperties(rows)[0].name;
    expect(aggregateStoredProperties([...rows].reverse())[0].name).toBe(first);
  });

  it("keeps genuinely different keys apart", () => {
    const properties = aggregateStoredProperties([
      { key: "date", value: "a", type: null },
      { key: "dueDate", value: "b", type: null },
    ]);

    expect(properties.map((property) => property.name).sort()).toEqual([
      "date",
      "dueDate",
    ]);
  });
});

describe("readDocumentProperty", () => {
  it("reads a key stored under another spelling", () => {
    expect(readDocumentProperty({ Date: "2026-01-01" }, "date")).toBe("2026-01-01");
    expect(readDocumentProperty({ date: "2026-01-01" }, "DATE")).toBe("2026-01-01");
  });

  it("prefers the exact spelling when the document holds it", () => {
    expect(readDocumentProperty({ date: "exact", Date: "other" }, "date")).toBe("exact");
  });

  it("still returns nothing for a key the document does not have", () => {
    expect(readDocumentProperty({ date: "2026-01-01" }, "deadline")).toBeUndefined();
  });
});

describe("normalizeDocumentPropertyPatch", () => {
  it("collapses two spellings in one patch, last one winning", () => {
    const operations = normalizeDocumentPropertyPatch({ date: "first", Date: "second" });

    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ kind: "update", value: "second" });
  });

  it("lets a delete of the other spelling win too", () => {
    const operations = normalizeDocumentPropertyPatch({ date: "value", Date: null });

    expect(operations).toEqual([{ kind: "delete", key: "Date" }]);
  });
});

const PORT = 7524;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let spaceId: string;

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_API_ONLY: "1",
  });
  await waitForServer(BASE_URL);

  const response = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({
      name: "Property Case Space",
      slug: `property-case-space-${Date.now()}`,
    }),
  });
  expect(response.status).toBe(201);
  spaceId = (await response.json()).space.id;
});

afterAll(async () => {
  serverProcess?.kill();
  if (spaceId) await deleteSpace(spaceId);
});

async function createDocument(properties: Record<string, unknown>): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({ content: "<p>body</p>", properties }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).document.id;
}

async function patchProperties(
  documentId: string,
  properties: Record<string, unknown>,
): Promise<Response> {
  return apiRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

async function documentProperties(documentId: string): Promise<Record<string, unknown>> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents/${documentId}`);
  expect(response.status).toBe(200);
  return (await response.json()).document.properties;
}

async function listProperties(): Promise<{ name: string; values: string[] }[]> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/properties`);
  expect(response.status).toBe(200);
  return (await response.json()).properties;
}

describe("a document holds one property per key, whatever the case", () => {
  it("updates the stored key instead of adding a second one", async () => {
    const documentId = await createDocument({ title: "Case patch", date: "2026-01-01" });

    expect((await patchProperties(documentId, { Date: "2026-02-02" })).status).toBe(200);

    const properties = await documentProperties(documentId);
    expect(properties.date).toBe("2026-02-02");
    expect(properties).not.toHaveProperty("Date");
  });

  it("keeps the spelling the property was created with", async () => {
    const documentId = await createDocument({ title: "Camel case", dueDate: "monday" });

    expect((await patchProperties(documentId, { DUEDATE: "tuesday" })).status).toBe(200);

    const properties = await documentProperties(documentId);
    expect(properties.dueDate).toBe("tuesday");
  });

  it("deletes the property named with the other spelling", async () => {
    const documentId = await createDocument({ title: "Case delete", stage: "draft" });

    expect((await patchProperties(documentId, { Stage: null })).status).toBe(200);

    expect(await documentProperties(documentId)).not.toHaveProperty("stage");
  });

  it("collapses a pair an older release stored, on the next write", async () => {
    const documentId = await createDocument({ title: "Legacy pair", date: "old" });
    const store = await openSpaceStore(spaceId);
    await store.db.insert(property).values({
      id: `property-legacy-${Date.now()}`,
      documentId,
      key: "Date",
      value: "older",
      type: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    expect(Object.keys(await documentProperties(documentId))).toContain("Date");

    expect((await patchProperties(documentId, { date: "new" })).status).toBe(200);

    const properties = await documentProperties(documentId);
    expect(properties.date).toBe("new");
    expect(properties).not.toHaveProperty("Date");
  });

  it("stores one property when a create names the key twice", async () => {
    const documentId = await createDocument({
      title: "Case create",
      owner: "first",
      Owner: "second",
    });

    const properties = await documentProperties(documentId);
    expect(
      Object.keys(properties).filter((key) => key.toLowerCase() === "owner"),
    ).toEqual(["Owner"]);
    expect(properties.Owner).toBe("second");
  });
});

describe("the space-wide listing folds spellings together", () => {
  it("lists one entry for two documents that disagree on case", async () => {
    await createDocument({ title: "Lower", region: "north" });
    await createDocument({ title: "Upper", Region: "south" });

    const entries = (await listProperties()).filter(
      (entry) => entry.name.toLowerCase() === "region",
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].values).toEqual(["north", "south"]);
  });
});

describe("filters match a property whatever case it was stored in", () => {
  it("finds the document through the other spelling", async () => {
    await createDocument({ title: "Filter target", priority: "high" });

    const filters = encodeURIComponent(
      JSON.stringify([{ key: "Priority", value: "high" }]),
    );
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/search?filters=${filters}`,
    );

    expect(response.status).toBe(200);
    const titles = (await response.json()).results.map(
      (result: { properties?: Record<string, unknown> }) => result.properties?.title,
    );
    expect(titles).toContain("Filter target");
  });
});
