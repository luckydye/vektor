import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { one } from "#db/client/query.ts";
import { openSpaceStore, type SpaceStore } from "#db/client/store.ts";
import { property, workflowSchedule } from "#db/schema/space.ts";
import { createDocument } from "#db/space/documents.ts";
import { syncPropertyTriggers } from "#db/space/propertyTriggers.ts";
import { createSpace, deleteSpace } from "#db/space/spaces.ts";
import { claimDueWorkflowSchedules } from "#db/space/workflowSchedules.ts";
import { platform } from "./helpers/platform.ts";

let store: SpaceStore;
let workflowId: string;

beforeAll(async () => {
  const space = await createSpace(platform,
    "alice",
    "Trigger reconciliation",
    `triggers-${Date.now()}`,
  );
  store = await openSpaceStore(platform, space.id);
  const workflow = await createDocument(store, "alice", "workflow", "", {
    type: "workflow",
  });
  workflowId = workflow.id;
});

afterAll(async () => {
  if (store) await deleteSpace(platform, store.spaceId, { purge: true });
});

async function scheduledDocument(anchor: Date, offsetMinutes: number) {
  return createDocument(store, "alice", "scheduled", "", {
    properties: {
      eventStart: { value: anchor.toISOString(), type: "date" },
      reminder: {
        value: JSON.stringify({ workflow: workflowId, from: "eventStart", offsetMinutes }),
        type: "trigger",
      },
    },
  });
}

async function scheduleFor(documentId: string) {
  const schedule = await one(
    store.db
      .select()
      .from(workflowSchedule)
      .where(eq(workflowSchedule.sourceDocumentId, documentId)),
  );
  if (!schedule) throw new Error("Expected a trigger schedule");
  return schedule;
}

describe("property trigger reconciliation", () => {
  it("arms a future firing time even when its source date is in the past", async () => {
    const anchor = new Date(Date.now() - 30 * 60_000);
    const doc = await scheduledDocument(anchor, 60);
    const schedule = await scheduleFor(doc.id);
    expect(schedule.enabled).toBe(true);
    expect(schedule.lastRunAt).toBeNull();
    expect(schedule.nextRunAt?.getTime()).toBe(
      Math.floor((anchor.getTime() + 60 * 60_000) / 1000) * 1000,
    );
  });

  it("consumes a past firing time even when its source date is in the future", async () => {
    const doc = await scheduledDocument(new Date(Date.now() + 30 * 60_000), -60);
    const schedule = await scheduleFor(doc.id);
    expect(schedule.enabled).toBe(false);
    expect(schedule.lastRunAt).not.toBeNull();
  });

  it("changes the writer when another user saves an unchanged trigger", async () => {
    const doc = await scheduledDocument(new Date(Date.now() + 60 * 60_000), 0);
    const before = await scheduleFor(doc.id);
    await store.tx((tx) =>
      syncPropertyTriggers(tx, doc.id, new Set(["reminder"]), "bob"),
    );
    const after = await scheduleFor(doc.id);
    expect(after.createdBy).toBe("bob");
    expect(after.id).toBe(before.id);
    expect(after.nextRunAt).toEqual(before.nextRunAt);
    expect(after.enabled).toBe(true);
    expect(after.lastRunAt).toBeNull();
  });

  it("changes the writer without rearming a consumed occurrence", async () => {
    const due = new Date(Date.now() + 60 * 60_000);
    const doc = await scheduledDocument(due, 0);
    await claimDueWorkflowSchedules(store, due);
    const consumed = await scheduleFor(doc.id);
    expect(consumed.enabled).toBe(false);
    expect(consumed.lastRunAt).not.toBeNull();
    await store.tx((tx) =>
      syncPropertyTriggers(tx, doc.id, new Set(["reminder"]), "bob"),
    );
    const after = await scheduleFor(doc.id);
    expect(after.createdBy).toBe("bob");
    expect(after.enabled).toBe(false);
    expect(after.lastRunAt).toEqual(consumed.lastRunAt);
    expect(after.nextRunAt).toEqual(consumed.nextRunAt);
    expect(await claimDueWorkflowSchedules(store, due)).toEqual([]);
  });

  it("preserves the trigger writer when another user edits only its source date", async () => {
    const doc = await scheduledDocument(new Date(Date.now() + 60 * 60_000), 0);
    const next = new Date(Date.now() + 120 * 60_000);
    await store.tx(async (tx) => {
      await tx.db.update(property).set({ value: next.toISOString() }).where(
        and(eq(property.documentId, doc.id), eq(property.key, "eventStart")),
      );
      await syncPropertyTriggers(tx, doc.id, new Set(["eventstart"]), "bob");
    });
    const schedule = await scheduleFor(doc.id);
    expect(schedule.createdBy).toBe("alice");
    expect(schedule.nextRunAt?.getTime()).toBe(
      Math.floor(next.getTime() / 1000) * 1000,
    );
  });
});
