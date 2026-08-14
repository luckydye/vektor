import { describe, expect, it } from "vitest";
import {
  addPositiveDays,
  isValidPositiveDayDuration,
  normalizeTimestamp,
} from "#utils/datetime.ts";

describe("datetime validation", () => {
  it.each([1, 0.5, 3650])("accepts a positive duration of %s days", (days) => {
    expect(isValidPositiveDayDuration(days, 3650)).toBe(true);
  });

  it.each([undefined, null, "1", Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 3651])(
    "rejects invalid or excessive day duration %s",
    (days) => {
      expect(isValidPositiveDayDuration(days, 3650)).toBe(false);
    },
  );

  it("adds days without mutating the source date", () => {
    const source = new Date("2026-01-01T00:00:00.000Z");
    expect(addPositiveDays(source, 1).toISOString()).toBe("2026-01-02T00:00:00.000Z");
    expect(source.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it.each(["not-a-date", "999999-01-01T00:00:00Z", Number.POSITIVE_INFINITY])(
    "rejects invalid timestamp %s",
    (value) => {
      expect(() => normalizeTimestamp(value)).toThrow();
    },
  );
});
