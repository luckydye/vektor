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

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase } from "#db/client/connection.ts";
import { initSpaceDbSchema } from "#db/client/init.ts";
import { exec, many } from "#db/client/query.ts";
import { isRevisionNumberConflict } from "#db/space/revisions.ts";
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

async function revisionNumbers(id: string): Promise<number[]> {
  const response = await apiRequest(documentPath(id, "/revisions"));
  expect(response.status).toBe(200);
  const revisions: { rev: number }[] = (await response.json()).revisions;
  return revisions.map((revision) => revision.rev);
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

    const revs = await revisionNumbers(id);
    expect(revs.length).toBeGreaterThan(0);
    expect(new Set(revs).size).toBe(revs.length);
  });

  it("leaves currentRev pointing at the newest revision", async () => {
    const id = await createDocument("Racing pointer");

    await concurrentSaves(id, 10);

    const revs = await revisionNumbers(id);
    expect((await documentMeta(id)).currentRev).toBe(Math.max(...revs));
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

describe("a database written before revision numbers were unique", () => {
  /** Three rows at `rev` 1, as an interrupted set of concurrent saves left them. */
  async function databaseWithCollidingRevisions() {
    const db = createDatabase("file::memory:");
    await initSpaceDbSchema(db, { local: false });
    // The collisions predate the index, so it cannot be in place while they are
    // written — which is exactly the state on disk before this fix shipped.
    await exec(db, sql.raw("DROP INDEX revision_document_id_rev_unique"));
    await exec(
      db,
      sql`INSERT INTO document (id, slug, content, current_rev, created_at, updated_at, created_by) VALUES ('doc', 'doc', '', 1, 0, 0, 'u')`,
    );
    for (const [id, createdAt] of [
      ["oldest", 10],
      ["middle", 20],
      ["newest", 30],
    ] as const) {
      await exec(
        db,
        sql`INSERT INTO revision (id, document_id, rev, slug, snapshot, checksum, created_at, created_by) VALUES (${id}, 'doc', 1, 'doc', x'00', ${id}, ${createdAt}, 'u')`,
      );
    }
    return db;
  }

  it("renumbers the collisions and keeps the row the pointers addressed", async () => {
    const db = await databaseWithCollidingRevisions();

    await initSpaceDbSchema(db, { local: false });

    const rows = await many<{ id: string; rev: number }>(
      db,
      sql.raw("SELECT id, rev FROM revision ORDER BY rev ASC"),
    );
    expect(rows).toEqual([
      { id: "oldest", rev: 1 },
      { id: "middle", rev: 2 },
      { id: "newest", rev: 3 },
    ]);
  });

  it("refuses a duplicate number, in the shape the insert retry recognises", async () => {
    const db = await databaseWithCollidingRevisions();
    await initSpaceDbSchema(db, { local: false });

    const rejection = await exec(
      db,
      sql`INSERT INTO revision (id, document_id, rev, slug, snapshot, checksum, created_at, created_by) VALUES ('extra', 'doc', 1, 'doc', x'00', 'extra', 40, 'u')`,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).not.toBeNull();
    expect(isRevisionNumberConflict(rejection)).toBe(true);
  });
});
