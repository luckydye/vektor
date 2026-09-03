/**
 * The space's write counter, and the one door every document write goes
 * through.
 *
 * A document carries the counter value it was last written at
 * (`document.change_seq`): its entity tag, and its position in the space's
 * write order. Both only work while every write moves it, which is why writers
 * call `touchDocument` instead of updating the row themselves. The one
 * exception is `writeDocumentIndex`, documented at that function.
 */

import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { document, spaceMetadata } from "#db/schema/space.ts";

/** A conflict is a result, not a failure: the caller re-reads and decides again. */
export type DocumentWriteResult = { ok: true; changeSeq: number } | { ok: false };

/** `missing` and `conflict` are different answers, and different status codes. */
export type DocumentWriteOutcome<T> =
  | { ok: true; document: T }
  | { ok: false; reason: "missing" | "conflict" };

export type DocumentWriteValues = Omit<
  Partial<typeof document.$inferInsert>,
  "id" | "changeSeq"
>;

/**
 * Take the next value from the space's counter, in the caller's transaction.
 *
 * Being a write, this takes SQLite's write lock where it runs and holds it to
 * the commit — so callers allocate before they read, and no other transaction
 * can interleave an allocation.
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
 * at one of `expected`. Zero rows updated is the conflict.
 *
 * A refused write still consumes the sequence it allocated. The gap costs
 * nothing: a consumer asks for everything above its position, and a number no
 * document carries is a number it never sees.
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

/** `guard` narrows what the write can reach; `expected` decides whether it happens. */
function documentCondition(
  id: string,
  expected: number[] | undefined,
  guard: SQL | undefined,
): SQL {
  // An `If-Match` naming only tags this server could not have issued decodes to
  // an empty list, and nothing is what it matches.
  if (expected?.length === 0) return sql`1 = 0`;

  const parts = [
    eq(document.id, id),
    ...(expected ? [inArray(document.changeSeq, expected)] : []),
    ...(guard ? [guard] : []),
  ];
  return and(...parts) as SQL;
}
