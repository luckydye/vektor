/**
 * The one cutover to the canvas object store (see docs/canvas-format.md,
 * Migration): every canvas's JSON snapshot, and each canvas revision's,
 * becomes its own base. A canvas whose row already names a base is skipped,
 * so an interrupted run resumes where it stopped.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { listActiveSpaceIds } from "#db/auth/spaceIndex.ts";
import { many } from "#db/client/query.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { document, revision } from "#db/schema/space.ts";
import { appLogger } from "#observability/logger.ts";
import type { Platform } from "#platform/platform.ts";
import { isCanvasBaseKey, writeBaseFromSnapshot } from "./canvasBase.ts";
import { parseCanvasSnapshot } from "./canvasSnapshot.ts";
import { readDocumentContent } from "./documentContent.ts";
import { getRevisionContent } from "./revisions.ts";

async function migrateCanvasRevisions(s: SpaceStore, documentId: string): Promise<void> {
  const rows = await many(
    s.db
      .select({ id: revision.id, rev: revision.rev, snapshot: revision.snapshot })
      .from(revision)
      .where(eq(revision.documentId, documentId)),
  );
  for (const row of rows) {
    if (isCanvasBaseKey(row.snapshot.toString("utf-8"))) continue;
    const content = await getRevisionContent(s, documentId, row.rev);
    if (content === null)
      throw new Error(`Revision ${row.rev} of canvas ${documentId} is unreadable`);
    const base = await writeBaseFromSnapshot(s, documentId, parseCanvasSnapshot(content));
    await s.db
      .update(revision)
      .set({
        snapshot: Buffer.from(base.key, "utf-8"),
        checksum: createHash("sha256").update(base.key, "utf-8").digest("hex"),
      })
      .where(eq(revision.id, row.id));
    if (row.snapshot.byteLength === 0) {
      await s.platform.blobStore.delete(s.spaceId, `revisions/${documentId}/${row.id}`);
    }
  }
}

async function migrateCanvas(
  s: SpaceStore,
  row: { id: string; content: string; contentKey: string | null },
): Promise<void> {
  // Revisions first: the row naming a base is what marks the canvas done.
  await migrateCanvasRevisions(s, row.id);
  const content = await readDocumentContent(s, row);
  const base = await writeBaseFromSnapshot(s, row.id, parseCanvasSnapshot(content));
  // No change_seq move: the document's content is the same, only where it lives.
  await s.db
    .update(document)
    .set({ contentKey: base.key, content: "" })
    .where(eq(document.id, row.id));
  if (row.contentKey !== null)
    await s.platform.blobStore.delete(s.spaceId, row.contentKey);
}

/** Converts every canvas not yet on the object store; runs before the server serves canvases. */
export async function migrateCanvases(platform: Platform): Promise<void> {
  for (const spaceId of await listActiveSpaceIds(platform)) {
    const s = await openSpaceStore(platform, spaceId);
    const canvases = await many(
      s.db
        .select({
          id: document.id,
          content: document.content,
          contentKey: document.contentKey,
        })
        .from(document)
        .where(eq(document.type, "canvas")),
    );
    for (const canvas of canvases) {
      if (isCanvasBaseKey(canvas.contentKey)) continue;
      try {
        await migrateCanvas(s, canvas);
        appLogger.info("Migrated a canvas to the object store", {
          spaceId,
          documentId: canvas.id,
        });
      } catch (error) {
        appLogger.error("Failed to migrate a canvas to the object store", {
          error,
          spaceId,
          documentId: canvas.id,
        });
        throw error;
      }
    }
  }
}
