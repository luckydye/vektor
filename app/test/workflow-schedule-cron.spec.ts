import { describe, expect, it } from "vitest";
import { computeNextRunAt, validateCronExpression } from "#db/workflowSchedules.ts";

/** What `date` reads as on a wall clock in `timezone`, as `YYYY-MM-DD HH:mm:ss`. */
function wallClock(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
  return parts.replace("T", " ");
}

describe("cron expression validation", () => {
  it("accepts 5- and 6-field expressions and nicknames", () => {
    expect(validateCronExpression("0 9 * * 1-5")).toEqual({ valid: true });
    expect(validateCronExpression("30 0 9 * * *")).toEqual({ valid: true });
    expect(validateCronExpression("@daily")).toEqual({ valid: true });
  });

  it("rejects malformed expressions with a message", () => {
    const tooFewFields = validateCronExpression("* *");
    expect(tooFewFields.valid).toBe(false);
    const outOfRange = validateCronExpression("0 99 * * *");
    expect(outOfRange.valid).toBe(false);
    expect(validateCronExpression("nonsense").valid).toBe(false);
  });

  it("rejects an unknown timezone", () => {
    expect(validateCronExpression("0 9 * * *", "Europe/Berlin")).toEqual({ valid: true });
    expect(validateCronExpression("0 9 * * *", "Mars/Olympus").valid).toBe(false);
  });
});

describe("computeNextRunAt", () => {
  it("returns the next occurrence strictly after `from`", () => {
    const from = new Date("2026-03-10T09:00:00Z");
    expect(computeNextRunAt("0 * * * *", "UTC", from).toISOString()).toBe(
      "2026-03-10T10:00:00.000Z",
    );
  });

  it("honours the day-of-week field", () => {
    // 2026-03-10 is a Tuesday; the next Monday is the 16th.
    const from = new Date("2026-03-10T09:00:00Z");
    expect(computeNextRunAt("0 8 * * 1", "UTC", from).toISOString()).toBe(
      "2026-03-16T08:00:00.000Z",
    );
  });

  it("interprets the expression in the schedule's timezone", () => {
    const from = new Date("2026-01-15T00:00:00Z");
    // 09:00 in Berlin is 08:00Z in winter, 07:00Z once CEST starts.
    expect(computeNextRunAt("0 9 * * *", "Europe/Berlin", from).toISOString()).toBe(
      "2026-01-15T08:00:00.000Z",
    );
    const summer = new Date("2026-07-15T00:00:00Z");
    expect(computeNextRunAt("0 9 * * *", "Europe/Berlin", summer).toISOString()).toBe(
      "2026-07-15T07:00:00.000Z",
    );
  });

  it("keeps the wall-clock time across a spring-forward transition", () => {
    // Berlin skips 02:00–03:00 on 2026-03-29. A 09:00 daily job stays at 09:00
    // local, so its UTC instant moves back an hour.
    const before = new Date("2026-03-28T12:00:00Z");
    const onTransitionDay = computeNextRunAt("0 9 * * *", "Europe/Berlin", before);
    expect(onTransitionDay.toISOString()).toBe("2026-03-29T07:00:00.000Z");
    expect(wallClock(onTransitionDay, "Europe/Berlin")).toBe("2026-03-29 09:00:00");
  });

  it("keeps the wall-clock time across a fall-back transition", () => {
    // Berlin repeats 02:00–03:00 on 2026-10-25.
    const before = new Date("2026-10-24T12:00:00Z");
    const onTransitionDay = computeNextRunAt("0 9 * * *", "Europe/Berlin", before);
    expect(onTransitionDay.toISOString()).toBe("2026-10-25T08:00:00.000Z");
    expect(wallClock(onTransitionDay, "Europe/Berlin")).toBe("2026-10-25 09:00:00");
  });

  it("resolves zones on the far side of the date line", () => {
    // 2026-01-15T19:00Z is already 08:00 on the 16th in Auckland (UTC+13).
    const from = new Date("2026-01-15T19:00:00Z");
    const next = computeNextRunAt("0 9 * * *", "Pacific/Auckland", from);
    expect(wallClock(next, "Pacific/Auckland")).toBe("2026-01-16 09:00:00");
    expect(next.toISOString()).toBe("2026-01-15T20:00:00.000Z");
  });

  it("handles a zone with a half-hour offset", () => {
    const from = new Date("2026-01-15T00:00:00Z");
    expect(computeNextRunAt("0 9 * * *", "Asia/Kolkata", from).toISOString()).toBe(
      "2026-01-15T03:30:00.000Z",
    );
  });

  it("supports a seconds field", () => {
    const from = new Date("2026-01-15T09:00:00Z");
    expect(computeNextRunAt("30 * * * * *", "UTC", from).toISOString()).toBe(
      "2026-01-15T09:00:30.000Z",
    );
  });

  it("throws on an expression it cannot parse", () => {
    expect(() => computeNextRunAt("nonsense", "UTC")).toThrow();
  });
});
