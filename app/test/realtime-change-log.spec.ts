import { describe, expect, it } from "vitest";
import {
  appendSyncEnvelope,
  catchUpSince,
  headSyncSeq,
  SYNC_HISTORY_LIMIT,
  syncEpoch,
} from "#realtime/changeLog.ts";

/**
 * The history is module state keyed by space, so every test invents its own
 * space id rather than resetting it — which is also how the server uses it.
 */
let counter = 0;
function aSpace(): string {
  counter += 1;
  return `change-log-space-${counter}`;
}

const all = () => true;

describe("Realtime change log", () => {
  it("hands out a position for a space that has published nothing", () => {
    const spaceId = aSpace();

    expect(headSyncSeq(spaceId)).toBe(0);
    // A client holding that position has missed nothing, and must not be told
    // to refetch: a quiet space is the common case on reconnect.
    expect(catchUpSince(spaceId, { epoch: syncEpoch, seq: 0 }, all)).toEqual({
      kind: "events",
      seq: 0,
      events: [],
    });
  });

  it("names the topics that changed after a cursor", () => {
    const spaceId = aSpace();
    const seen = headSyncSeq(spaceId);

    appendSyncEnvelope(spaceId, [{ topic: "space:documents" }]);
    appendSyncEnvelope(spaceId, [{ topic: "space:categories" }]);

    const catchUp = catchUpSince(spaceId, { epoch: syncEpoch, seq: seen }, all);
    expect(catchUp.kind).toBe("events");
    if (catchUp.kind !== "events") return;
    expect(catchUp.seq).toBe(2);
    expect(catchUp.events.map(({ topic }) => topic).sort()).toEqual([
      "space:categories",
      "space:documents",
    ]);
  });

  it("collapses a topic named repeatedly onto its most recent payload", () => {
    const spaceId = aSpace();
    const seen = headSyncSeq(spaceId);

    appendSyncEnvelope(spaceId, [{ topic: "space:documents", data: { rev: 1 } }]);
    appendSyncEnvelope(spaceId, [{ topic: "space:documents", data: { rev: 2 } }]);

    const catchUp = catchUpSince(spaceId, { epoch: syncEpoch, seq: seen }, all);
    if (catchUp.kind !== "events") throw new Error("expected events");
    expect(catchUp.events).toEqual([{ topic: "space:documents", data: { rev: 2 } }]);
  });

  it("narrows the answer to the topics a connection listens on", () => {
    const spaceId = aSpace();
    const seen = headSyncSeq(spaceId);

    appendSyncEnvelope(spaceId, [
      { topic: "space:documents" },
      { topic: "space:categories" },
    ]);

    const catchUp = catchUpSince(
      spaceId,
      { epoch: syncEpoch, seq: seen },
      (topic) => topic === "space:categories",
    );
    if (catchUp.kind !== "events") throw new Error("expected events");
    expect(catchUp.events).toEqual([{ topic: "space:categories" }]);
    // The position still advances past the envelope, so an ignored topic is not
    // re-read on every reconnect.
    expect(catchUp.seq).toBe(1);
  });

  it("advances a cursor past envelopes holding nothing it listens on", () => {
    const spaceId = aSpace();
    const seen = headSyncSeq(spaceId);

    appendSyncEnvelope(spaceId, [{ topic: "space:extensions" }]);

    const catchUp = catchUpSince(
      spaceId,
      { epoch: syncEpoch, seq: seen },
      (topic) => topic === "space:documents",
    );
    expect(catchUp).toEqual({ kind: "events", seq: 1, events: [] });
  });

  it("reports nothing missed when the cursor is already at the head", () => {
    const spaceId = aSpace();
    appendSyncEnvelope(spaceId, [{ topic: "space:documents" }]);

    const head = headSyncSeq(spaceId);
    expect(catchUpSince(spaceId, { epoch: syncEpoch, seq: head }, all)).toEqual({
      kind: "events",
      seq: head,
      events: [],
    });
  });

  it("demands a resync for a cursor issued by another process", () => {
    const spaceId = aSpace();
    appendSyncEnvelope(spaceId, [{ topic: "space:documents" }]);

    // The failure this guards is silent: without the epoch, a cursor from a
    // previous process would read the new numbering as already seen.
    expect(catchUpSince(spaceId, { epoch: "a-previous-process", seq: 1 }, all)).toEqual({
      kind: "resync",
    });
  });

  it("demands a resync once the entries a cursor needs have been dropped", () => {
    const spaceId = aSpace();
    const seen = headSyncSeq(spaceId);

    for (let i = 0; i <= SYNC_HISTORY_LIMIT; i += 1) {
      appendSyncEnvelope(spaceId, [{ topic: `document:${i}` }]);
    }

    expect(catchUpSince(spaceId, { epoch: syncEpoch, seq: seen }, all)).toEqual({
      kind: "resync",
    });
    // The newest entries are still describable, so a current client is spared.
    const recent = catchUpSince(
      spaceId,
      { epoch: syncEpoch, seq: SYNC_HISTORY_LIMIT },
      all,
    );
    expect(recent.kind).toBe("events");
  });

  it("keeps numbering contiguous while trimming history", () => {
    const spaceId = aSpace();
    for (let i = 0; i < SYNC_HISTORY_LIMIT + 5; i += 1) {
      appendSyncEnvelope(spaceId, [{ topic: "space:documents" }]);
    }

    expect(headSyncSeq(spaceId)).toBe(SYNC_HISTORY_LIMIT + 5);
    const catchUp = catchUpSince(
      spaceId,
      { epoch: syncEpoch, seq: SYNC_HISTORY_LIMIT + 4 },
      all,
    );
    if (catchUp.kind !== "events") throw new Error("expected events");
    expect(catchUp.events).toEqual([{ topic: "space:documents" }]);
  });

  it("numbers spaces independently", () => {
    const first = aSpace();
    const second = aSpace();

    appendSyncEnvelope(first, [{ topic: "space:documents" }]);
    appendSyncEnvelope(first, [{ topic: "space:documents" }]);

    expect(headSyncSeq(first)).toBe(2);
    expect(headSyncSeq(second)).toBe(0);
    expect(catchUpSince(second, { epoch: syncEpoch, seq: 0 }, all)).toEqual({
      kind: "events",
      seq: 0,
      events: [],
    });
  });
});
