const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every timestamp shape the API and DB hand out, as a valid `Date`: epoch
 * seconds and milliseconds are told apart by magnitude, numeric strings
 * included. This module has no localization or frontend dependencies, so it is
 * safe to use from server validation paths.
 */
export function normalizeTimestamp(value: string | number | Date): Date {
  let parsed: Date;

  if (value instanceof Date) {
    parsed = value;
  } else if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid numeric timestamp: ${value}`);
    }
    parsed = new Date(value < 1e12 ? value * 1000 : value);
  } else {
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (!Number.isFinite(numeric)) {
        throw new Error(`Invalid numeric timestamp: ${value}`);
      }
      parsed = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    } else {
      parsed = new Date(trimmed);
    }
  }

  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Invalid timestamp: ${String(value)}`);
  }
  return parsed;
}

/** Whether a value is a finite, positive duration no longer than `maxDays`. */
export function isValidPositiveDayDuration(
  value: unknown,
  maxDays = Number.POSITIVE_INFINITY,
): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= maxDays
  );
}

/** Add a validated positive day duration without mutating the source date. */
export function addPositiveDays(date: Date, days: number): Date {
  if (!isValidPositiveDayDuration(days)) {
    throw new Error("Days must be a finite positive number");
  }
  return normalizeTimestamp(date.getTime() + days * MILLISECONDS_PER_DAY);
}
