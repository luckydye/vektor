import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  appendNodeLog,
  clearRunStoreForTests,
  createRun,
  ensureSpaceRecovered,
  finalizeRun,
  flushRunStoreForTests,
  getLatestRunIdForDoc,
  getRun,
  getRunForRead,
  listRuns,
  RUN_STORE_RECOVERY_ERROR,
  resetRunStoreMemoryForTests,
  setNodeStatus,
  setRunStatus,
} from "./runStore.ts";

const SPACE_ID = "space_run_store_test";

describe("runStore", () => {
  beforeEach(async () => {
    await clearRunStoreForTests(SPACE_ID);
  });

  afterEach(async () => {
    await clearRunStoreForTests(SPACE_ID);
  });

  it("persists runs to the DB and recovers interrupted nodes after a restart", async () => {
    const runId = createRun(
      SPACE_ID,
      "doc_1",
      ["node1", "node2", "node3"],
      "user_1",
      "empco-linter",
    );
    const completedAt = new Date("2026-04-09T10:00:00.000Z");
    const startedAt = new Date("2026-04-09T10:01:00.000Z");

    setRunStatus(runId, "running");
    setNodeStatus(runId, "node1", {
      status: "completed",
      outputs: { value: "done" },
      completedAt,
    });
    appendNodeLog(runId, "node1", "finished");
    setNodeStatus(runId, "node2", {
      status: "running",
      inputs: { prompt: "hello" },
      startedAt,
    });

    // Drain pending writes, then simulate a process restart: memory is gone
    // while the DB row is left in the "running" state.
    await flushRunStoreForTests();
    resetRunStoreMemoryForTests();

    await ensureSpaceRecovered(SPACE_ID);

    expect(await getLatestRunIdForDoc(SPACE_ID, "doc_1")).toBe(runId);

    const run = await getRunForRead(SPACE_ID, runId);
    expect(run).toBeDefined();
    expect(run?.status).toBe("failed");
    expect(run?.spaceId).toBe(SPACE_ID);
    expect(run?.initiatedByUserId).toBe("user_1");
    expect(run?.sourceExtensionId).toBe("empco-linter");

    const node1 = run?.nodes.get("node1");
    expect(node1?.status).toBe("completed");
    expect(node1?.logs).toEqual(["finished"]);
    expect(node1?.completedAt).toEqual(completedAt);

    const node2 = run?.nodes.get("node2");
    expect(node2?.status).toBe("failed");
    expect(node2?.error).toBe(RUN_STORE_RECOVERY_ERROR);
    expect(node2?.startedAt).toEqual(startedAt);
    expect(node2?.completedAt).toBeInstanceOf(Date);

    const node3 = run?.nodes.get("node3");
    expect(node3?.status).toBe("cancelled");
    expect(node3?.completedAt).toBeInstanceOf(Date);
  });

  it("evicts completed runs from memory but keeps them as durable history", async () => {
    const runId = createRun(SPACE_ID, "doc_2", ["node1"]);
    setRunStatus(runId, "running");
    setNodeStatus(runId, "node1", { status: "completed", outputs: { ok: true } });
    finalizeRun(runId);

    // The terminal run is dropped from the active in-memory map…
    expect(getRun(runId)).toBeUndefined();

    await flushRunStoreForTests();

    // …but remains readable from the DB, and is not pruned from history.
    const fromDb = await getRunForRead(SPACE_ID, runId);
    expect(fromDb?.status).toBe("completed");
    expect(fromDb?.nodes.get("node1")?.status).toBe("completed");

    const all = await listRuns(SPACE_ID);
    expect(all.some((entry) => entry.runId === runId)).toBe(true);
  });
});
