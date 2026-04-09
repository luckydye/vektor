import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendNodeLog,
  clearRunStoreForTests,
  createRun,
  getRun,
  latestRunByDoc,
  reloadRunStoreFromDisk,
  RUN_STORE_RECOVERY_ERROR,
  setNodeStatus,
  setRunStatus,
  setRunStoreFilePathForTests,
} from "./runStore.ts";

let testDir = "";

describe("runStore", () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "vektor-run-store-"));
    setRunStoreFilePathForTests(join(testDir, "runs.json"));
    clearRunStoreForTests();
  });

  afterEach(() => {
    clearRunStoreForTests();
    rmSync(testDir, { recursive: true, force: true });
  });

  it("persists workflow runs and recovers interrupted nodes after reload", () => {
    const runId = createRun("space_1", "doc_1", ["node1", "node2", "node3"], "user_1");
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

    reloadRunStoreFromDisk();

    expect(latestRunByDoc.get("doc_1")).toBe(runId);

    const run = getRun(runId);
    expect(run).toBeDefined();
    expect(run?.status).toBe("failed");
    expect(run?.spaceId).toBe("space_1");
    expect(run?.initiatedByUserId).toBe("user_1");

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
});
