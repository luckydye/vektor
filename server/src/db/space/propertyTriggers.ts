import { and, eq } from "drizzle-orm";
import { PermissionDeniedError } from "#acl/errors.ts";
import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import { createId } from "#db/ids.ts";
import {
  document,
  property,
  workflowSchedule,
} from "#db/schema/space.ts";
import {
  canonicalPropertyKey,
  type DocumentPropertyPatchOperation,
  InvalidDocumentPropertyPatchError,
  parseStoredPropertyValue,
  parseTriggerSpec,
  TRIGGER_PROPERTY_TYPE,
  type TriggerSpec,
} from "#documents/properties.ts";
import { isWorkflowCreationEnabled } from "#utils/spacePreferences.ts";
import { getSpace } from "./spaces.ts";

function writerOf(key: string, userId: string | undefined): string {
  if (!userId) {
    throw new InvalidDocumentPropertyPatchError(
      `Trigger "${key}" needs a user to run its workflow as`,
    );
  }
  return userId;
}

/** Triggers start workflows, so they exist only where workflows are enabled. */
export async function assertTriggersEnabled(spaceId: string): Promise<void> {
  if (!isWorkflowCreationEnabled((await getSpace(spaceId))?.preferences)) {
    throw new PermissionDeniedError("Workflows are disabled for this space");
  }
}

/**
 * Refuse a patch that arms a trigger its writer could not run by hand: the
 * space must have workflows enabled, the workflow must exist and the writer
 * must hold EDITOR on it, the role a manual run requires. Runs before the write's transaction, since the ACL lookup reads
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
    if (!writesTrigger) continue;
    await assertTriggersEnabled(s.spaceId);
    if (operation.value === "") continue;

    const writer = writerOf(operation.key, userId);
    const { workflow } = parseTriggerSpec(operation.key, operation.value);
    const target = await one(
      s.db
        .select({ type: document.type })
        .from(document)
        .where(eq(document.id, workflow)),
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

/** When a trigger is due, and the instant that hangs off: its `at`, or the date it follows. */
function resolveSchedule(
  spec: TriggerSpec,
  values: Map<string, string>,
): { anchor: Date; fireAt: Date } | null {
  if ("at" in spec) return { anchor: new Date(spec.at), fireAt: new Date(spec.at) };
  const date = values.get(canonicalPropertyKey(spec.from));
  if (!date) return null;
  const time = new Date(date).getTime();
  if (Number.isNaN(time)) return null;
  return { anchor: new Date(time), fireAt: new Date(time + spec.offsetMinutes * 60_000) };
}

/**
 * Bring a document's one-shot workflow schedules in line with its trigger properties, inside the transaction that wrote `writtenKeys`.
 * A trigger the write moved, itself or through the date it follows, re-arms to run as `userId`, already fired if that date has passed.
 */
export async function syncPropertyTriggers(
  s: SpaceStore,
  documentId: string,
  writtenKeys: Set<string>,
  userId: string | undefined,
): Promise<void> {
  const now = new Date();
  const rows = await many(
    s.db.select().from(property).where(eq(property.documentId, documentId)),
  );
  const existing = await many(
    s.db
      .select()
      .from(workflowSchedule)
      .where(eq(workflowSchedule.sourceDocumentId, documentId)),
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
    if (!triggerKeys.has(canonicalPropertyKey(stale.propertyKey ?? ""))) {
      await s.db.delete(workflowSchedule).where(eq(workflowSchedule.id, stale.id));
    }
  }

  for (const row of triggerRows) {
    const key = canonicalPropertyKey(row.key);
    const spec = parseTriggerSpec(row.key, parseStoredPropertyValue(row.value));
    const rearmed =
      writtenKeys.has(key) ||
      ("from" in spec && writtenKeys.has(canonicalPropertyKey(spec.from)));
    if (!rearmed) continue;

    const schedule = resolveSchedule(spec, values);
    // SQLite timestamp columns store whole seconds. Compare at that same
    // precision so an unchanged ISO date with milliseconds stays consumed.
    const fireAt = schedule
      ? new Date(Math.floor(schedule.fireAt.getTime() / 1000) * 1000)
      : null;
    const current = existing.find(
      (entry) => canonicalPropertyKey(entry.propertyKey ?? "") === key,
    );
    const target = await one(
      s.db
        .select({ type: document.type })
        .from(document)
        .where(eq(document.id, spec.workflow)),
    );
    // Deleting a workflow cascades its schedule rows, but the document's
    // property remains editable. A date edit must not recreate a dangling FK.
    if (target?.type !== "workflow") {
      if (current) {
        await s.db.delete(workflowSchedule).where(eq(workflowSchedule.id, current.id));
      }
      continue;
    }
    // Re-saving an unchanged schedule must not re-arm a trigger that already fired.
    if (
      current?.documentId === spec.workflow &&
      current.nextRunAt?.getTime() === fireAt?.getTime()
    ) {
      continue;
    }

    const armed = {
      propertyKey: row.key,
      documentId: spec.workflow,
      sourceDocumentId: documentId,
      inputs: JSON.stringify({ documentId, propertyKey: row.key }),
      cronExpression: null,
      createdBy: writerOf(row.key, userId),
      nextRunAt: fireAt,
      enabled: !!schedule && schedule.anchor > now,
      lastRunAt: schedule && schedule.anchor <= now ? now : null,
      updatedAt: now,
    };
    if (current) {
      await s.db
        .update(workflowSchedule)
        .set(armed)
        .where(eq(workflowSchedule.id, current.id));
    } else {
      await s.db
        .insert(workflowSchedule)
        .values({ id: createId("workflowSchedule"), createdAt: now, ...armed });
    }
  }
}

