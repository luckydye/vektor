/**
 * The space's write counter, and the one door every document write goes
 * through.
 *
 * A document carries the counter value it was last written at
 * (`document.change_seq`). That value does two jobs: it is the document's
 * entity tag, so a reader can ask "is this still what I saw?", and it is a
 * position in the space's write order, so a consumer can ask "what changed
 * since I last looked?". Both answers are only as good as the rule that every
 * write moves it, which is why writers call {@link touchDocument} rather than
 * updating the row themselves.
 */

import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { document, spaceMetadata } from "#db/schema/space.ts";

/**
 * The outcome of a write that carried a condition.
 *
 * A conflict is a result rather than a failure: losing a race is how a writer
 * finds out it has to re-read and decide again. The shape mirrors
 * `ConditionalPutResult` in `#files/storage.ts` on purpose, but carries the
 * sequence instead of an entity tag — spelling a tag is the HTTP layer's
 * business, and nothing down here should know how one is written.
 */
export type DocumentWriteResult = { ok: true; changeSeq: number } | { ok: false };

/**
 * A conditional write that also hands back what it wrote, for the callers whose
 * answer is the document rather than a status.
 *
 * The two ways to fail are kept apart because they are different answers to the
 * caller and different answers over HTTP: a document that is not there was
 * never a candidate for the condition, while one that is there and moved on is
 * a race the caller can retry.
 */
export type DocumentWriteOutcome<T> =
  | { ok: true; document: T }
  | { ok: false; reason: "missing" | "conflict" };

/**
 * What a write may set. `changeSeq` is absent because it is not the caller's to
 * choose, and `id` because a write that renames a document is a different
 * operation from the one this models.
 */
export type DocumentWriteValues = Omit<
  Partial<typeof document.$inferInsert>,
  "id" | "changeSeq"
>;

/**
 * Take the next value from the space's counter.
 *
 * Always inside the caller's transaction, so the number and the write it
 * describes commit or roll back together. Being a write, it also takes SQLite's
 * write lock at the point it runs — which is why callers allocate before they
 * read anything else: the lock is held from there to the commit, and no second
 * transaction can interleave an allocation into the gap.
 */
export async function nextChangeSeq(s: SpaceStore): Promise<number> {
  // No key: a space database holds exactly one metadata row.
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
 * Write a document and move its sequence, optionally only while it still sits
 * at one of `expected`.
 *
 * The comparison is part of the write, not a read before it: a caller that
 * checks the sequence and then updates has a gap between the two that another
 * writer fits inside. Zero rows updated is the conflict, and the only way to
 * learn about one.
 *
 * A refused write still consumes the sequence it allocated. That leaves a gap
 * in the counter, which costs nothing — a consumer asks for everything above
 * the position it holds, and a number no document carries is simply a number it
 * never sees.
 */
export async function touchDocument(
  s: SpaceStore,
  id: string,
  values: DocumentWriteValues,
  expected?: number[],
  guard?: SQL,
): Promise<DocumentWriteResult> {
  return s.tx(async (tx) => {
    const changeSeq = await nextChangeSeq(tx);
    const rows = await many(
      tx.db
        .update(document)
        .set({ ...values, changeSeq })
        .where(documentCondition(id, expected, guard))
        .returning({ id: document.id }),
    );
    return rows.length > 0 ? { ok: true, changeSeq } : { ok: false };
  });
}

/**
 * Delete a document, optionally only while it still sits at one of `expected`.
 *
 * No sequence is allocated: the row is going, so there is nothing left to carry
 * one. What a consumer needs in order to notice the deletion is a tombstone,
 * which is a separate concern from the counter.
 */
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

/**
 * `guard` is for a caller that will only ever write one kind of document and
 * wants that stated in the statement rather than assumed — it narrows what the
 * write can reach, where `expected` decides whether it happens at all.
 */
function documentCondition(
  id: string,
  expected: number[] | undefined,
  guard: SQL | undefined,
): SQL {
  // An `If-Match` naming only tags this server could not have issued decodes to
  // nothing, and nothing is what it can match. Spelled out rather than handed to
  // `inArray` as an empty list, whose SQL is a question about the query builder
  // instead of a statement about the condition.
  if (expected?.length === 0) return sql`1 = 0`;

  // `inArray` rather than `eq`, because `If-Match` is a list and the condition
  // it states is "any of these" — which one statement can express and a loop of
  // statements cannot do atomically.
  const parts = [
    eq(document.id, id),
    ...(expected ? [inArray(document.changeSeq, expected)] : []),
    ...(guard ? [guard] : []),
  ];
  return and(...parts) as SQL;
}
