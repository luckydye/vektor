import { and, eq, inArray } from "drizzle-orm";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { document, property } from "#db/schema/space.ts";
import {
  aggregateStoredProperties,
  type DocumentPropertyPatch,
  type DocumentPropertyPatchOperation,
  type DocumentPropertyValue,
  normalizeDocumentPropertyPatch,
  parseStoredPropertyValue,
  propertyValueToText,
  serializePropertyValue,
  type SpaceProperty,
} from "#documents/properties.ts";
import { isPlaceholderDocumentSlug } from "#documents/types.ts";
import { createAuditLog } from "./auditLogs.ts";
import { EmptyDocumentSlugError, generateUniqueSlug } from "./documents.ts";
import {
  nonArchivedDocumentCondition,
  updateDocumentEmbeddingBestEffort,
} from "./search.ts";

export interface PatchDocumentPropertiesResult {
  slug?: string;
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

  return generateUniqueSlug(s, titleUpdate.value, documentId).catch(
    (error: unknown) => {
      if (error instanceof EmptyDocumentSlugError) return undefined;
      throw error;
    },
  );
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
): Promise<PatchDocumentPropertiesResult> {
  const operations = normalizeDocumentPropertyPatch(patch);
  if (operations.length === 0) return {};

  const result = await s.tx(async (txStore) => {
    const now = new Date();
    const keys = operations.map((operation) => operation.key);
    const existingRows = await many(
      txStore.db
        .select()
        .from(property)
        .where(and(eq(property.documentId, documentId), inArray(property.key, keys))),
    );
    const existingByKey = new Map(existingRows.map((row) => [row.key, row]));
    const changes: DocumentPropertyChange[] = [];

    for (const operation of operations) {
      const existing = existingByKey.get(operation.key);
      const previousValue = existing
        ? parseStoredPropertyValue(existing.value)
        : undefined;

      if (operation.kind === "delete") {
        await txStore.db
          .delete(property)
          .where(
            and(
              eq(property.documentId, documentId),
              eq(property.key, operation.key),
            ),
          );

        if (existing) {
          await createAuditLog(txStore, {
            docId: documentId,
            userId,
            event: "property_delete",
            details: {
              propertyKey: operation.key,
              propertyType: existing.type || undefined,
              previousValue: propertyValueToText(previousValue ?? ""),
            },
          });
        }

        changes.push({
          kind: "document_property_deleted",
          propertyKey: operation.key,
          propertyType: existing?.type ?? null,
          previousValue: previousValue ?? null,
        });
        continue;
      }

      const storedValue = serializePropertyValue(operation.value);
      const nextType =
        operation.type === undefined ? (existing?.type ?? null) : operation.type;
      if (existing) {
        const updateData: {
          value: string;
          updatedAt: Date;
          type?: string | null;
        } = { value: storedValue, updatedAt: now };
        if (operation.type !== undefined) updateData.type = operation.type;
        await txStore.db
          .update(property)
          .set(updateData)
          .where(eq(property.id, existing.id));
      } else {
        await txStore.db.insert(property).values({
          id: createId("property"),
          documentId,
          key: operation.key,
          value: storedValue,
          type: operation.type || null,
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

    const renamedSlug = await resolveRenamedSlug(txStore, documentId, operations);
    await txStore.db
      .update(document)
      .set({ ...(renamedSlug ? { slug: renamedSlug } : {}), updatedAt: now })
      .where(eq(document.id, documentId));

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

    return renamedSlug ? { slug: renamedSlug } : {};
  });

  void updateDocumentEmbeddingBestEffort(s, documentId);
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
    { name: "type", type: "select", values: typeValues },
    ...aggregateStoredProperties(allProperties),
  ].sort((a, b) => a.name.localeCompare(b.name));
}
