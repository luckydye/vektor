/**
 * One revision number per revision, however many saves race for it.
 *
 * `createRevision` used to read `max(rev)`, compress the snapshot, and only then
 * insert — so every concurrent save of a document read the same number and
 * stored a row at it (issue #165). Fifteen saves answered 200 and fourteen were
 * lost, and `currentRev`/`publishedRev` addressed several rows at once.
 *
 * Runs against a file-backed space database, not `VEKTOR_IN_MEMORY_DB`: the
 * point is what the real driver does when writes overlap.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "#db/client/connection.ts";
import { initSpaceDbSchema } from "#db/client/init.ts";
import { many } from "#db/client/query.ts";
import { deleteSpace } from "#db/space/spaces.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7525;
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
      name: "Revision Concurrency Space",
      slug: `revision-concurrency-${Date.now()}`,
    }),
  });
  expect(response.status).toBe(201);
  spaceId = (await response.json()).space.id;
});

afterAll(async () => {
  serverProcess?.kill();
  if (spaceId) await deleteSpace(spaceId);
});

function documentPath(id: string, suffix = ""): string {
  return `/api/v1/spaces/${spaceId}/documents/${id}${suffix}`;
}

async function createDocument(title: string): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({ content: "<p>initial</p>", properties: { title } }),
  });
  expect(response.status).toBe(201);
  return (await response.json()).document.id;
}

/** Fires `count` saves without awaiting any of them in between. */
function concurrentSaves(
  id: string,
  count: number,
  mode: "revision" | "suggestion" = "revision",
): Promise<Response[]> {
  return Promise.all(
    Array.from({ length: count }, (_, index) =>
      apiRequest(documentPath(id), {
        method: "POST",
        body: JSON.stringify({ html: `<p>save ${index}</p>`, mode }),
      }),
    ),
  );
}

async function revisionRows(id: string): Promise<{ rev: number; checksum: string }[]> {
  const response = await apiRequest(documentPath(id, "/revisions"));
  expect(response.status).toBe(200);
  return (await response.json()).revisions;
}

async function revisionNumbers(id: string): Promise<number[]> {
  return (await revisionRows(id)).map((revision) => revision.rev);
}

async function documentMeta(id: string): Promise<{
  currentRev: number;
  publishedRev: number | null;
}> {
  const response = await apiRequest(documentPath(id));
  expect(response.status).toBe(200);
  return (await response.json()).document;
}

async function revisionContent(id: string, rev: number): Promise<string> {
  const response = await apiRequest(documentPath(id, `?rev=${rev}`));
  expect(response.status).toBe(200);
  return (await response.json()).revision.content;
}

async function publish(id: string, rev: number): Promise<void> {
  const response = await apiRequest(documentPath(id), {
    method: "PATCH",
    body: JSON.stringify({ publishedRev: rev }),
  });
  expect(response.status).toBe(200);
}

describe("concurrent saves of one document", () => {
  it("gives every stored revision its own number", async () => {
    const id = await createDocument("Racing saves");

    const responses = await concurrentSaves(id, 15);
    expect(responses.map((response) => response.status)).toEqual(
      Array.from({ length: 15 }, () => 200),
    );

    // Every save reaches the document without a prior revision to overwrite, so
    // all fifteen are stored — the fourteen the old allocation lost included.
    const revs = await revisionNumbers(id);
    expect(revs.length).toBe(15);
    expect(new Set(revs).size).toBe(15);
  });

  it("leaves currentRev pointing at the newest revision", async () => {
    const id = await createDocument("Racing pointer");

    await concurrentSaves(id, 10);

    const revs = await revisionNumbers(id);
    expect((await documentMeta(id)).currentRev).toBe(Math.max(...revs));
  });

  // Saves inside the three-hour window coalesce into the revision already
  // there, so racing ones overwrite each other instead of each taking a number.
  it("coalesces racing saves into the revision they all overwrite", async () => {
    const id = await createDocument("Racing overwrites");

    const firstSave = await apiRequest(documentPath(id), {
      method: "POST",
      body: JSON.stringify({ html: "<p>base body</p>", mode: "revision" }),
    });
    expect(firstSave.status).toBe(200);
    const rev = (await firstSave.json()).revision.rev as number;

    const responses = await concurrentSaves(id, 10);
    const reported = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        return (await response.json()).revision.rev as number;
      }),
    );

    expect(reported).toEqual(Array.from({ length: 10 }, () => rev));
    expect(await revisionNumbers(id)).toEqual([rev]);
    expect((await documentMeta(id)).currentRev).toBe(rev);
    // Whichever update landed last owns the row whole: one save's body under
    // its own checksum, never one save's content beside another's.
    const content = await revisionContent(id, rev);
    expect(content).toMatch(/^<p>save \d<\/p>$/);
    const [stored] = await revisionRows(id);
    expect(stored.checksum).toBe(
      createHash("sha256").update(content, "utf-8").digest("hex"),
    );
  });

  it("cannot overwrite the published revision by racing saves against it", async () => {
    const id = await createDocument("Racing publish");

    const firstSave = await apiRequest(documentPath(id), {
      method: "POST",
      body: JSON.stringify({ html: "<p>published body</p>", mode: "revision" }),
    });
    expect(firstSave.status).toBe(200);
    const publishedRev = (await firstSave.json()).revision.rev;
    await publish(id, publishedRev);

    await concurrentSaves(id, 20);

    const revs = await revisionNumbers(id);
    expect(new Set(revs).size).toBe(revs.length);
    expect(await revisionContent(id, publishedRev)).toContain("published body");
    expect((await documentMeta(id)).publishedRev).toBe(publishedRev);
  });

  it("keeps every concurrent suggestion, each at its own number", async () => {
    const id = await createDocument("Racing suggestions");

    const firstSave = await apiRequest(documentPath(id), {
      method: "POST",
      body: JSON.stringify({ html: "<p>base body</p>", mode: "revision" }),
    });
    expect(firstSave.status).toBe(200);

    // Suggestions are never overwritten in place, so all ten must survive as
    // ten distinct revisions with the content each one proposed.
    const responses = await concurrentSaves(id, 10, "suggestion");
    const suggested = await Promise.all(
      responses.map(async (response) => {
        expect(response.status).toBe(200);
        return (await response.json()).revision.rev as number;
      }),
    );

    expect(new Set(suggested).size).toBe(10);
    const contents = await Promise.all(suggested.map((rev) => revisionContent(id, rev)));
    expect(new Set(contents).size).toBe(10);
  });
});

// Allocating the number inside the insert is what keeps saves from colliding,
// but only this index makes `(documentId, rev)` a pointer the rest of the code
// can trust — nothing above fails if a second writer is allowed to duplicate it.
describe("a space database", () => {
  it("holds a unique index on (document_id, rev)", async () => {
    const db = createDatabase("file::memory:");
    await initSpaceDbSchema(db, { local: false });

    const indexes = await many<{ name: string; unique: number }>(
      db,
      sql.raw("PRAGMA index_list('revision')"),
    );
    const unique = indexes.find(
      (index) => index.name === "revision_document_id_rev_unique",
    );
    expect(unique?.unique).toBe(1);

    const columns = await many<{ name: string }>(
      db,
      sql.raw("PRAGMA index_info('revision_document_id_rev_unique')"),
    );
    expect(columns.map((column) => column.name)).toEqual(["document_id", "rev"]);
  });
});
