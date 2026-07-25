import { describe, expect, it } from "bun:test";
import {
  coerceStepCache,
  createStepCacheWriter,
  openResumeState,
  sealResumeState,
  stepCacheKey,
  type WorkflowStepCache,
} from "#jobs/workflowStepCache.ts";

describe("workflow step cache key", () => {
  it("is stable regardless of input key ordering", () => {
    const a = stepCacheKey("workflow-builder", "chat-completion", {
      prompt: "hi",
      content: "world",
    });
    const b = stepCacheKey("workflow-builder", "chat-completion", {
      content: "world",
      prompt: "hi",
    });
    expect(a).toBe(b);
  });

  it("differs when the extension, job, or inputs differ", () => {
    const base = stepCacheKey("workflow-builder", "convert", { x: 1 });
    expect(stepCacheKey("other-ext", "convert", { x: 1 })).not.toBe(base);
    expect(stepCacheKey("workflow-builder", "chat-completion", { x: 1 })).not.toBe(base);
    expect(stepCacheKey("workflow-builder", "convert", { x: 2 })).not.toBe(base);
  });

  it("handles nested objects and arrays deterministically", () => {
    const a = stepCacheKey("e", "j", { list: [{ b: 2, a: 1 }], meta: { z: 1, y: 2 } });
    const b = stepCacheKey("e", "j", { meta: { y: 2, z: 1 }, list: [{ a: 1, b: 2 }] });
    expect(a).toBe(b);
    // Array order is significant.
    const c = stepCacheKey("e", "j", { list: [{ a: 1 }, { a: 2 }] });
    const d = stepCacheKey("e", "j", { list: [{ a: 2 }, { a: 1 }] });
    expect(c).not.toBe(d);
  });
});

describe("coerceStepCache", () => {
  it("keeps well-formed entries and drops non-object ones", () => {
    const input = {
      good: { file: "http://x/y.zip", count: "3" },
      alsoGood: {},
      badArray: [1, 2],
      badScalar: "nope",
      badNull: null,
    };
    const out: WorkflowStepCache = coerceStepCache(input);
    expect(Object.keys(out).sort()).toEqual(["alsoGood", "good"]);
    expect(out.good).toEqual({ file: "http://x/y.zip", count: "3" });
  });

  it("returns an empty object for non-object payloads", () => {
    expect(coerceStepCache(null)).toEqual({});
    expect(coerceStepCache("x")).toEqual({});
    expect(coerceStepCache([1, 2])).toEqual({});
    expect(coerceStepCache(undefined)).toEqual({});
  });
});

describe("step cache writer", () => {
  it("carries the seed forward and keeps the first value for a key", () => {
    const writer = createStepCacheWriter({ a: { v: 1 } });
    writer.record("b", { v: 2 });
    writer.record("a", { v: 99 });
    expect(writer.snapshot()).toEqual({ a: { v: 1 }, b: { v: 2 } });
    expect(writer.droppedSteps()).toBe(0);
  });

  it("drops oversized step outputs instead of caching them", () => {
    const writer = createStepCacheWriter();
    writer.record("small", { text: "ok" });
    writer.record("huge", { text: "x".repeat(300 * 1024) });
    expect(Object.keys(writer.snapshot())).toEqual(["small"]);
    expect(writer.droppedSteps()).toBe(1);
  });

  it("stops caching once the total budget is exhausted", () => {
    const writer = createStepCacheWriter();
    const chunk = { text: "x".repeat(200 * 1024) };
    for (let i = 0; i < 60; i++) writer.record(`step-${i}`, chunk);
    // 8 MB budget / ~200 KB entries — well short of all 60.
    expect(Object.keys(writer.snapshot()).length).toBeLessThan(60);
    expect(writer.droppedSteps()).toBeGreaterThan(0);
  });

  it("re-bounds an oversized seed rather than trusting it", () => {
    const seed: WorkflowStepCache = {};
    for (let i = 0; i < 60; i++) seed[`step-${i}`] = { text: "x".repeat(200 * 1024) };
    const writer = createStepCacheWriter(seed);
    expect(Object.keys(writer.snapshot()).length).toBeLessThan(60);
    expect(writer.droppedSteps()).toBeGreaterThan(0);
  });
});

describe("resume state sealing", () => {
  // Encryption derives its key from config; these tests run in-process, so give
  // it a key the same way startTestServer does for the server specs.
  process.env.AUTH_SECRET ??= "workflow-step-cache-test-secret-do-not-use";

  it("round-trips inputs and steps through encryption", () => {
    const state = {
      inputs: { token: "s3cret", prompt: "x".repeat(5000) },
      steps: { key: { out: "value" } },
    };
    const sealed = sealResumeState(state);
    // The plaintext must not be recoverable from the stored artifact.
    expect(JSON.stringify(sealed)).not.toContain("s3cret");
    expect(openResumeState(sealed)).toEqual(state);
  });

  it("returns null for payloads it cannot open", () => {
    expect(openResumeState(null)).toBe(null);
    expect(openResumeState({ inputs: {}, steps: {} })).toBe(null);
    expect(
      openResumeState({ v: 1, ciphertext: "bogus", iv: "bogus", authTag: "bogus" }),
    ).toBe(null);
  });
});
