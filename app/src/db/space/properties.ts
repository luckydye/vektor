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
 * Insert a property only while no document in the space already carries that
 * key and value, reporting whether it landed.
 *
 * The point of the `NOT EXISTS` is that it is *inside* the insert. A caller that
 * looks for the value and then writes has a gap another writer fits inside —
 * the same gap `touchDocument` exists to close on the update path. One statement
 * has no gap: SQLite admits one writer at a time, so the loser's subquery sees
 * the winner's committed row and matches nothing.
 *
 * Call inside the transaction that creates the document, so a refusal rolls the
 * document back with it.
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

    // First write in the transaction, so a refused condition rolls back before
    // any property row lands behind a sequence that never moved.
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

export async function getAllPropertiesWithValues(
  s: SpaceStore,
): Promise<SpaceProperty[]> {
  // Joining to document hides orphaned rows left by permanent deletes and keeps
  // archived properties consistent with the virtual type values below.
  const allProperties = await many(
    s.db
      .select({ key: property.key, value: property.value, type: property.type })
      .from(property)
      .innerJoin(document, eq(property.documentId, document.id))
      .where(nonArchivedDocumentCondition),
  );

  const docTypes = await many(
    s.db
      .selectDistinct({ type: document.type })
      .from(document)
      .where(nonArchivedDocumentCondition),
  );
  const typeValues = docTypes
    .map((row) => row.type || "document")
    .filter((value, index, values) => values.indexOf(value) === index)
    .sort();

  if (!typeValues.includes("file")) {
    typeValues.push("file");
    typeValues.sort();
  }

  return [
    { name: DOCUMENT_TYPE_FILTER_KEY, type: "select", values: typeValues },
    ...aggregateStoredProperties(allProperties),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
