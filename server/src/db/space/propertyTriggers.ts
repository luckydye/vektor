import { and, eq } from "drizzle-orm";
import { PermissionDeniedError } from "#acl/errors.ts";
import { verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { many, one } from "#db/client/query.ts";
import type { SpaceStore } from "#db/client/store.ts";
import {
  document,
  property,
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
import { syncPropertyWorkflowSchedules } from "./workflowSchedules.ts";

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

/** When a trigger is due, including any offset from the date it follows. */
function resolveSchedule(
  spec: TriggerSpec,
  values: Map<string, string>,
): Date | null {
  if ("at" in spec) return new Date(spec.at);
  const date = values.get(canonicalPropertyKey(spec.from));
  if (!date) return null;
  const time = new Date(date).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time + spec.offsetMinutes * 60_000);
}

/**
 * Bring a document's one-shot workflow schedules in line with its trigger properties, inside the transaction that wrote `writtenKeys`.
 * Writing a trigger sets its execution identity to `userId`. Moving only the
 * date it follows preserves that identity. Past due times are already consumed.
 */
export async function syncPropertyTriggers(
  s: SpaceStore,
  documentId: string,
  writtenKeys: Set<string>,
  userId: string | undefined,
): Promise<void> {
  const rows = await many(
    s.db.select().from(property).where(eq(property.documentId, documentId)),
  );
  const values = new Map<string, string>();
  for (const row of rows) {
    const value = parseStoredPropertyValue(row.value);
    if (typeof value === "string") values.set(canonicalPropertyKey(row.key), value);
  }

  const triggers = rows
    .filter((row) => row.type === TRIGGER_PROPERTY_TYPE && row.value !== "")
    .map((row) => {
      const spec = parseTriggerSpec(row.key, parseStoredPropertyValue(row.value));
      const schedule = resolveSchedule(spec, values);
      return {
        propertyKey: row.key,
        workflowId: spec.workflow,
        runAt: schedule,
        triggerWritten: writtenKeys.has(canonicalPropertyKey(row.key)),
        changed:
          writtenKeys.has(canonicalPropertyKey(row.key)) ||
          ("from" in spec && writtenKeys.has(canonicalPropertyKey(spec.from))),
      };
    });

  await syncPropertyWorkflowSchedules(s, documentId, triggers, userId);
}
