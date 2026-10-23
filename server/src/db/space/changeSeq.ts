/**
 * The space's write counter, and the one door every document write goes through.
 *
 * `document.change_seq` is the document's entity tag. It only works while every
 * write moves it, so writers call `touchDocument` rather than updating the row.
 * `writeDocumentIndex` is the one exception.
 */

import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { document, spaceMetadata } from "#db/schema/space.ts";
import {
  contentColumns,
  deleteSpilledContent,
  type StoredDocumentContent,
} from "./documentContent.ts";

export type DocumentWriteResult = { ok: true; changeSeq: number } | { ok: false };

/** Different answers, and different status codes. */
export type DocumentWriteOutcome<T> =
  | { ok: true; document: T }
  | { ok: false; reason: "missing" | "conflict" };

/** A column takes a value or a SQL expression over its current one. */
export type DocumentWriteValues = Omit<
  {
    [K in keyof typeof document.$inferInsert]?: (typeof document.$inferInsert)[K] | SQL;
  },
  "id" | "changeSeq" | "content" | "contentKey"
> & {
  /** From `storeDocumentContent`, before the transaction, since spilling it is external I/O. */
  content?: StoredDocumentContent;
};

/**
 * Take the next value from the space's counter, in the caller's transaction.
 *
 * Being a write, it takes SQLite's write lock and holds it to the commit — so
 * callers allocate first and no other transaction interleaves an allocation.
 */
export async function nextChangeSeq(s: SpaceStore): Promise<number> {
  // One metadata row per space database, so no key.
  const row = await one(
    s.db
      .update(spaceMetadata)
      .set({ changeSeq: sql`${spaceMetadata.changeSeq} + 1` })
      .returning({ changeSeq: spaceMetadata.changeSeq }),
  );
  if (!row) {
    throw new Error("Space metadata is missing; cannot allocate a change sequence");
  }
  return row.changeSeq;
}

/**
 * Write a document and move its sequence, optionally only while it still sits at
 * one of `expected`. Zero rows updated is the conflict.
 */
export async function touchDocument(
  s: SpaceStore,
  id: string,
  values: DocumentWriteValues,
  expected?: number[],
  guard?: SQL,
): Promise<DocumentWriteResult> {
  const { content, ...columns } = values;
  if (content && content.documentId !== id) {
    throw new Error(
      `Content stored for ${content.documentId} cannot be written to ${id}`,
    );
  }
  return s.tx(async (tx) => {
    const changeSeq = await nextChangeSeq(tx);
    const replaced =
      content &&
      (await one(
        tx.db
          .select({ contentKey: document.contentKey })
          .from(document)
          .where(eq(document.id, id)),
      ));
    const rows = await many(
      tx.db
        .update(document)
        .set({
          ...columns,
          ...(content && contentColumns(content)),
          changeSeq,
        })
        .where(documentCondition(id, expected, guard))
        .returning({ id: document.id }),
    );
    const written = rows.length > 0;
    // A write that throws leaves its blob under the document's prefix, removed with the document.
    const unreferenced = written ? replaced?.contentKey : content?.contentKey;
    if (unreferenced)
      tx.afterCommit((store) => void deleteSpilledContent(store, unreferenced));
    return written ? { ok: true, changeSeq } : { ok: false };
  });
}

/**
 * Write several documents at one sequence.
 *
 * They changed together, so they share the value — and it is one statement
 * rather than one per document.
 */
export async function touchDocuments(
  s: SpaceStore,
  ids: string[],
  values: Omit<DocumentWriteValues, "content">,
): Promise<void> {
  if (ids.length === 0) return;
  await s.tx(async (tx) => {
    const changeSeq = await nextChangeSeq(tx);
    await tx.db
      .update(document)
      .set({ ...values, changeSeq })
      .where(inArray(document.id, ids));
  });
}

/** Delete a document, optionally only while it still sits at one of `expected`. */
export async function deleteDocumentRow(
  s: SpaceStore,
  id: string,
  expected?: number[],
): Promise<boolean> {
  const rows = await many(
    s.db
      .delete(document)
      .where(documentCondition(id, expected, undefined))
      .returning({ id: document.id }),
  );
  return rows.length > 0;
}

function documentCondition(
  id: string,
  expected: number[] | undefined,
  guard: SQL | undefined,
): SQL {
  // An empty list is a condition nothing satisfies.
  if (expected?.length === 0) return sql`1 = 0`;

  const parts = [
    eq(document.id, id),
    ...(expected ? [inArray(document.changeSeq, expected)] : []),
    ...(guard ? [guard] : []),
  ];
  return and(...parts) as SQL;
}
