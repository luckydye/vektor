import { eq, sql } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { document, property } from "#db/schema/space.ts";
import {
  aggregateStoredProperties,
  canonicalPropertyKey,
  DOCUMENT_TYPE_FILTER_KEY,
  type DocumentPropertyPatch,
  type DocumentPropertyPatchOperation,
  type DocumentPropertyValue,
  normalizeDocumentPropertyPatch,
  parseStoredPropertyValue,
  propertyValueToText,
  type SpaceProperty,
  type StoredPropertyKeyRow,
  serializePropertyValue,
} from "#documents/properties.ts";
import { isPlaceholderDocumentSlug } from "#documents/types.ts";
import { scheduleDocumentSearchRefresh } from "#search/indexing.ts";
import { slugify } from "#utils/slug.ts";
import { createAuditLog } from "./auditLogs.ts";
import { touchDocument } from "./changeSeq.ts";
import { generateUniqueSlug } from "./documents.ts";
import { nonArchivedDocumentCondition } from "./search.ts";

export interface PatchDocumentPropertiesResult {
  slug?: string;
  /** The condition named a sequence the document had already moved past. */
  conflict?: true;
  changeSeq?: number;
}

interface DocumentPropertyChange {
  kind: "document_property_changed" | "document_property_deleted";
  propertyKey: string;
  propertyType: string | null;
  previousValue: DocumentPropertyValue | null;
  value?: DocumentPropertyValue;
}

async function resolveRenamedSlug(
  s: SpaceStore,
  documentId: string,
  operations: DocumentPropertyPatchOperation[],
): Promise<string | undefined> {
  const titleUpdate = operations.find(
    (operation) =>
      operation.kind === "update" &&
      operation.key === "title" &&
      typeof operation.value === "string" &&
      operation.value.length > 0,
  );
  if (titleUpdate?.kind !== "update" || typeof titleUpdate.value !== "string") {
    return undefined;
  }

  const current = await one(
    s.db
      .select({ slug: document.slug })
      .from(document)
      .where(eq(document.id, documentId)),
  );
  if (!current || !isPlaceholderDocumentSlug(current.slug)) return undefined;
  // The rename still happens; only the derived slug cannot follow, so the
  // placeholder stays rather than becoming a no-better generated slug.
  if (!slugify(titleUpdate.value)) return undefined;

  return generateUniqueSlug(s, titleUpdate.value, documentId);
}

/**
 * Insert a property only while no document in the space carries that key and
 * value. Returns whether it landed.
 *
 * The `NOT EXISTS` is inside the insert: one statement, and SQLite admits one
 * writer at a time, so the loser's subquery sees the winner's committed row.
 * Checking and then inserting would leave a gap. Call inside the transaction
 * that creates the document, so a refusal rolls it back.
 */
export async function insertUniqueProperty(
  s: SpaceStore,
  documentId: string,
  key: string,
  value: string,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await many<{ id: string }>(
    s.db,
    sql`
      INSERT INTO property (id, document_id, key, value, type, created_at, updated_at)
      SELECT ${createId("property")}, ${documentId}, ${key}, ${value}, NULL, ${now}, ${now}
      WHERE NOT EXISTS (
        SELECT 1 FROM property WHERE key = ${key} AND value = ${value}
      )
      RETURNING id
    `,
  );
  return rows.length > 0;
}

/**
 * Apply one document property patch as a single persistence operation.
 *
 * The complete patch is normalized before the transaction starts. Property
 * rows, audit entries, and the document timestamp then commit together; the
 * realtime layer receives one change describing the whole batch, and search is
 * refreshed once after commit.
 */
export async function patchDocumentProperties(
  s: SpaceStore,
  documentId: string,
  patch: DocumentPropertyPatch,
  userId?: string,
  expected?: number[],
): Promise<PatchDocumentPropertiesResult> {
  const operations = normalizeDocumentPropertyPatch(patch);
  if (operations.length === 0) return {};

  const result = await s.tx(async (txStore): Promise<PatchDocumentPropertiesResult> => {
    const now = new Date();
    const existingRows = await many(
      txStore.db.select().from(property).where(eq(property.documentId, documentId)),
    );
    const existingByKey = new Map<string, typeof existingRows>();
    for (const row of existingRows) {
      const canonical = canonicalPropertyKey(row.key);
      const group = existingByKey.get(canonical);
      if (group) group.push(row);
      else existingByKey.set(canonical, [row]);
    }
    for (const group of existingByKey.values()) {
      group.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    }
    const changes: DocumentPropertyChange[] = [];

    // First write in the transaction, so a refusal rolls back cleanly.
    const renamedSlug = await resolveRenamedSlug(txStore, documentId, operations);
    const written = await touchDocument(
      txStore,
      documentId,
      { ...(renamedSlug ? { slug: renamedSlug } : {}), updatedAt: now },
      expected,
    );
    if (!written.ok) return { conflict: true } as const;

    // Folding two spellings together destroys a stored value, so it is logged and
    // broadcast like any other delete.
    const removeRow = async (row: (typeof existingRows)[number]) => {
      const value = parseStoredPropertyValue(row.value);
      await txStore.db.delete(property).where(eq(property.id, row.id));
      await createAuditLog(txStore, {
        docId: documentId,
        userId,
        event: "property_delete",
        details: {
          propertyKey: row.key,
          propertyType: row.type || undefined,
          previousValue: propertyValueToText(value),
        },
      });

      changes.push({
        kind: "document_property_deleted",
        propertyKey: row.key,
        propertyType: row.type ?? null,
        previousValue: value,
      });
    };

    for (const operation of operations) {
      const group = existingByKey.get(canonicalPropertyKey(operation.key)) ?? [];
      // The row the patch already names, else the one written most recently: that
      // row is renamed, so the spelling of the last write is the one stored.
      const current = group.find((row) => row.key === operation.key) ?? group[0];
      const previousValue = current ? parseStoredPropertyValue(current.value) : undefined;

      for (const row of group) {
        if (row !== current) await removeRow(row);
      }

      if (operation.kind === "delete") {
        if (current) await removeRow(current);
        else {
          changes.push({
            kind: "document_property_deleted",
            propertyKey: operation.key,
            propertyType: null,
            previousValue: null,
          });
        }
        continue;
      }

      const storedValue = serializePropertyValue(operation.value);
      const nextType =
        operation.type === undefined ? (current?.type ?? null) : operation.type;
      if (current) {
        const updateData: {
          key: string;
          value: string;
          updatedAt: Date;
          type?: string | null;
        } = { key: operation.key, value: storedValue, updatedAt: now };
        if (operation.type !== undefined) updateData.type = operation.type;
        await txStore.db
          .update(property)
          .set(updateData)
          .where(eq(property.id, current.id));
      } else {
        await txStore.db.insert(property).values({
          id: createId("property"),
          documentId,
          key: operation.key,
          value: storedValue,
          type: nextType || null,
          createdAt: now,
          updatedAt: now,
        });
      }

      await createAuditLog(txStore, {
        docId: documentId,
        userId,
        event: "property_update",
        details: {
          propertyKey: operation.key,
          propertyType: nextType || undefined,
          previousValue: previousValue ? propertyValueToText(previousValue) : undefined,
          newValue: propertyValueToText(operation.value),
        },
      });

      changes.push({
        kind: "document_property_changed",
        propertyKey: operation.key,
        propertyType: nextType,
        previousValue: previousValue ?? null,
        value: operation.value,
      });
    }

    txStore.emit({
      kind: "documentProperties",
      documentId,
      affectsTree: operations.some((operation) =>
        ["title", "category", "collection"].includes(operation.key),
      ),
      data: {
        kind: "document_properties_changed",
        documentId,
        changes,
      },
    });

    return renamedSlug
      ? { slug: renamedSlug, changeSeq: written.changeSeq }
      : { changeSeq: written.changeSeq };
  });

  if (result.conflict) return result;

  scheduleDocumentSearchRefresh(s, documentId);
  return result;
}

/**
 * The property keys used in a space, with their types. A key only archived
 * documents hold is left out; spellings are weighed over every stored row.
 */
export async function listSpaceProperties(s: SpaceStore): Promise<SpaceProperty[]> {
  const rows = await many<StoredPropertyKeyRow>(
    s.db,
    sql`
      SELECT k.key AS key, k.count AS count,
        (SELECT min(t.type) FROM ${property} t WHERE t.key = k.key AND t.type IS NOT NULL) AS type
      FROM (SELECT key, count(*) AS count FROM ${property} GROUP BY key) k
      WHERE EXISTS (
        SELECT 1 FROM ${property} p JOIN ${document} ON ${document.id} = p.document_id
        WHERE p.key = k.key AND ${nonArchivedDocumentCondition}
      )
    `,
  );

  return [
    { name: DOCUMENT_TYPE_FILTER_KEY, type: "select" },
    ...aggregateStoredProperties(rows),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The distinct values non-archived documents hold for one property key, in
 * every spelling of it, with multi-value rows unpacked. `prefix` matches case-insensitively.
 */
export async function listPropertyValues(
  s: SpaceStore,
  key: string,
  options: { prefix: string; limit: number },
): Promise<{ values: string[]; hasMore: boolean }> {
  const canonical = canonicalPropertyKey(key);
  const prefix = options.prefix.toLowerCase();
  const page = (values: string[]) => ({
    values: values.slice(0, options.limit),
    hasMore: values.length > options.limit,
  });

  if (canonical === DOCUMENT_TYPE_FILTER_KEY) {
    const rows = await many(
      s.db
        .selectDistinct({ type: document.type })
        .from(document)
        .where(nonArchivedDocumentCondition),
    );
    const types = new Set(["file", ...rows.map((row) => row.type || "document")]);
    return page([...types].filter((type) => type.toLowerCase().startsWith(prefix)).sort());
  }

  const spellings = (
    await many<{ key: string }>(s.db, sql`SELECT DISTINCT key FROM ${property}`)
  )
    .map((row) => row.key)
    .filter((spelling) => canonicalPropertyKey(spelling) === canonical);
  if (spellings.length === 0) return { values: [], hasMore: false };

  const keys = sql.join(
    spellings.map((spelling) => sql`${spelling}`),
    sql`, `,
  );
  const isArray = sql`(p.value LIKE '[%' AND json_valid(p.value) AND json_type(p.value) = 'array')`;
  const rows = await many<{ value: string }>(
    s.db,
    sql`
      SELECT value FROM (
        SELECT p.value AS value FROM ${property} p
        JOIN ${document} ON ${document.id} = p.document_id
        WHERE p.key IN (${keys}) AND ${nonArchivedDocumentCondition} AND NOT ${isArray}
        UNION
        SELECT CAST(j.value AS TEXT) FROM ${property} p
        JOIN ${document} ON ${document.id} = p.document_id, json_each(p.value) j
        WHERE p.key IN (${keys}) AND ${nonArchivedDocumentCondition} AND ${isArray}
      )
      WHERE value <> '' AND substr(lower(value), 1, ${prefix.length}) = ${prefix}
      ORDER BY value
      LIMIT ${options.limit + 1}
    `,
  );
  return page(rows.map((row) => row.value));
}
