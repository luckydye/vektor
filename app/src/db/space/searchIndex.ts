/**
 * Reads and writes behind the search index columns on `document`.
 *
 * What goes into them — the flattened text a document is searched by and its
 * embedding — is decided in `#search/indexing.ts`; this module only moves rows.
 */

import { eq, sql } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { document, file as fileTable, property } from "#db/schema/space.ts";
import { nonArchivedDocumentCondition } from "./conditions.ts";

export interface DocumentIndexSource {
  content: string;
  properties: (typeof property.$inferSelect)[];
  files: (typeof fileTable.$inferSelect)[];
}

export interface DocumentIndex {
  searchText: string;
  searchEmbedding: string;
  searchEmbeddingModel: string;
  searchUpdatedAt: Date;
}

/**
 * The document's type on its own. Canvases are never indexed and their content
 * can be tens of megabytes, so the decision to skip one is made before
 * `readDocumentIndexSource` pulls that column into memory.
 */
export async function readDocumentType(
  s: SpaceStore,
  documentId: string,
): Promise<{ type: string | null } | null> {
  return (
    (await one(
      s.db
        .select({ type: document.type })
        .from(document)
        .where(eq(document.id, documentId)),
    )) ?? null
  );
}

/** Everything a document is indexed from: its content, properties and files. */
export async function readDocumentIndexSource(
  s: SpaceStore,
  documentId: string,
): Promise<DocumentIndexSource | null> {
  const doc = await one(s.db.select().from(document).where(eq(document.id, documentId)));

  if (!doc) {
    return null;
  }

  return {
    content: doc.content,
    properties: await many(
      s.db.select().from(property).where(eq(property.documentId, documentId)),
    ),
    files: await many(
      s.db.select().from(fileTable).where(eq(fileTable.documentId, documentId)),
    ),
  };
}

export async function writeDocumentIndex(
  s: SpaceStore,
  documentId: string,
  index: DocumentIndex,
): Promise<void> {
  await s.db.update(document).set(index).where(eq(document.id, documentId));
}

export async function clearDocumentIndex(
  s: SpaceStore,
  documentId: string,
): Promise<void> {
  await s.db
    .update(document)
    .set({
      searchText: null,
      searchEmbedding: null,
      searchEmbeddingModel: null,
      searchUpdatedAt: null,
    })
    .where(eq(document.id, documentId));
}

/** Documents that can carry an index — everything except canvases. */
export async function readIndexableDocumentIds(s: SpaceStore): Promise<string[]> {
  const rows = await many(
    s.db
      .select({ id: document.id })
      .from(document)
      .where(sql`(${document.type} IS NULL OR ${document.type} != 'canvas')`),
  );

  return rows.map((row) => row.id);
}

/**
 * Documents whose index is missing, written by a different embedding model, or
 * older than the document itself.
 */
export async function readStaleIndexDocumentIds(
  s: SpaceStore,
  embeddingModel: string,
): Promise<string[]> {
  const rows = await many(
    s.db
      .select({ id: document.id })
      .from(document)
      .where(
        sql`(search_embedding IS NULL OR search_text IS NULL OR search_embedding_model IS NULL OR search_embedding_model != ${embeddingModel} OR search_updated_at IS NULL OR search_updated_at < updated_at)
        AND (type IS NULL OR type != 'canvas')
        AND ${nonArchivedDocumentCondition}`,
      ),
  );

  return rows.map((row) => row.id);
}
