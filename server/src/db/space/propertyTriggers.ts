import { and, eq, isNull, lte } from "drizzle-orm";
import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import { document, type PropertyTrigger, property, propertyTrigger } from "#db/schema/space.ts";
import {
  canonicalPropertyKey,
  type DocumentPropertyPatchOperation,
  InvalidDocumentPropertyPatchError,
  parseStoredPropertyValue,
  parseTriggerSpec,
  TRIGGER_PROPERTY_TYPE,
  type TriggerSpec,
} from "#documents/properties.ts";

function writerOf(key: string, userId: string | undefined): string {
  if (!userId) {
    throw new InvalidDocumentPropertyPatchError(
      `Trigger "${key}" needs a user to run its workflow as`,
    );
  }
  return userId;
}

/**
 * Refuse a patch that arms a trigger its writer could not run by hand: the
 * workflow must exist and the writer must hold EDITOR on it, the role a manual
 * run requires. Runs before the write's transaction, since the ACL lookup reads
 * outside it.
 *
 * @param documentId The patched document, or null for one being created.
 */
export async function authorizeTriggerWrites(
  s: SpaceStore,
  documentId: string | null,
  operations: DocumentPropertyPatchOperation[],
  userId: string | undefined,
): Promise<void> {
  const existingTriggerKeys = new Set(
    documentId
      ? (
          await many(
            s.db
              .select({ key: property.key })
              .from(property)
              .where(
                and(
                  eq(property.documentId, documentId),
                  eq(property.type, TRIGGER_PROPERTY_TYPE),
                ),
              ),
          )
        ).map((row) => canonicalPropertyKey(row.key))
      : [],
  );

  for (const operation of operations) {
    if (operation.kind !== "update") continue;
    // An update naming no type keeps the stored one, so it rewrites a trigger too.
    const writesTrigger =
      operation.type === TRIGGER_PROPERTY_TYPE ||
      (operation.type === undefined &&
        existingTriggerKeys.has(canonicalPropertyKey(operation.key)));
    if (!writesTrigger || operation.value === "") continue;

    const writer = writerOf(operation.key, userId);
    const { workflow } = parseTriggerSpec(operation.key, operation.value);
    const target = await one(
      s.db.select({ type: document.type }).from(document).where(eq(document.id, workflow)),
    );
    if (target?.type !== "workflow") {
      throw new InvalidDocumentPropertyPatchError(
        `Trigger "${operation.key}" must name a workflow document`,
      );
    }
    await verifyAccess(
      s.spaceId,
      { type: ResourceType.DOCUMENT, id: workflow },
      writer,
      Permission.EDITOR,
    );
  }
}

function resolveFireAt(spec: TriggerSpec, values: Map<string, string>): Date | null {
  if ("at" in spec) return new Date(spec.at);
  const date = values.get(canonicalPropertyKey(spec.from));
  if (!date) return null;
  const time = new Date(date).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time + spec.offsetMinutes * 60_000);
}

/**
 * Bring a document's `property_trigger` rows in line with its trigger
 * properties. Call inside the transaction that wrote the properties, after the
 * writes, with the canonical keys the write touched.
 *
 * A trigger the write itself set runs as `userId` from now on; one that only
 * moved because the date it follows changed keeps its writer. A due time that
 * lands in the past is recorded as already fired, so arming a trigger never
 * fires it on the spot.
 */
export async function syncPropertyTriggers(
  s: SpaceStore,
  documentId: string,
  changedKeys: Set<string>,
  userId: string | undefined,
): Promise<void> {
  const now = new Date();
  const rows = await many(
    s.db.select().from(property).where(eq(property.documentId, documentId)),
  );
  const existing = await many(
    s.db.select().from(propertyTrigger).where(eq(propertyTrigger.documentId, documentId)),
  );

  const values = new Map<string, string>();
  for (const row of rows) {
    const value = parseStoredPropertyValue(row.value);
    if (typeof value === "string") values.set(canonicalPropertyKey(row.key), value);
  }

  const triggerRows = rows.filter(
    (row) => row.type === TRIGGER_PROPERTY_TYPE && row.value !== "",
  );
  const triggerKeys = new Set(triggerRows.map((row) => canonicalPropertyKey(row.key)));

  for (const stale of existing) {
    if (!triggerKeys.has(canonicalPropertyKey(stale.propertyKey))) {
      await s.db.delete(propertyTrigger).where(eq(propertyTrigger.id, stale.id));
    }
  }

  for (const row of triggerRows) {
    const key = canonicalPropertyKey(row.key);
    const spec = parseTriggerSpec(row.key, parseStoredPropertyValue(row.value));
    const fireAt = resolveFireAt(spec, values);
    const current = existing.find((entry) => canonicalPropertyKey(entry.propertyKey) === key);
    const rewritten = changedKeys.has(key);
    if (!rewritten && current && current.fireAt?.getTime() === fireAt?.getTime()) {
      continue;
    }

    const due = {
      fireAt,
      firedAt: fireAt && fireAt <= now ? now : null,
      updatedAt: now,
    };
    if (!current) {
      await s.db.insert(propertyTrigger).values({
        id: createId("propertyTrigger"),
        documentId,
        propertyKey: row.key,
        workflowId: spec.workflow,
        createdBy: writerOf(row.key, userId),
        ...due,
      });
    } else if (rewritten) {
      await s.db
        .update(propertyTrigger)
        .set({
          propertyKey: row.key,
          workflowId: spec.workflow,
          createdBy: writerOf(row.key, userId),
          ...due,
        })
        .where(eq(propertyTrigger.id, current.id));
    } else {
      await s.db.update(propertyTrigger).set(due).where(eq(propertyTrigger.id, current.id));
    }
  }
}

/**
 * Claim every trigger whose time has come. The guarded update marks each one
 * fired, so a trigger is handed out once even if two ticks race.
 */
export async function claimDuePropertyTriggers(
  s: SpaceStore,
  now: Date,
): Promise<PropertyTrigger[]> {
  const due = await many(
    s.db
      .select({ id: propertyTrigger.id })
      .from(propertyTrigger)
      .where(and(isNull(propertyTrigger.firedAt), lte(propertyTrigger.fireAt, now))),
  );

  const claimed: PropertyTrigger[] = [];
  for (const { id } of due) {
    const [trigger] = await s.db
      .update(propertyTrigger)
      .set({ firedAt: now })
      .where(
        and(
          eq(propertyTrigger.id, id),
          isNull(propertyTrigger.firedAt),
          lte(propertyTrigger.fireAt, now),
        ),
      )
      .returning();
    if (trigger) claimed.push(trigger);
  }
  return claimed;
}
