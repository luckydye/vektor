import { normalizeTimestamp } from "#utils/datetime.ts";
import { currentLang } from "#utils/lang.ts";

export type RelativeTimeOptions = {
  style?: "long" | "short" | "narrow";
  maxDays?: number;
  dayOnly?: boolean;
  capitalize?: boolean;
  now?: number;
};

/** Localized relative time with an optional absolute-date fallback. */
export function formatRelativeTime(
  value: string | number | Date,
  options: RelativeTimeOptions = {},
): string {
  const {
    style = "long",
    maxDays = Number.POSITIVE_INFINITY,
    dayOnly,
    capitalize,
  } = options;

  try {
    const date = normalizeTimestamp(value);
    const diffMs = (options.now ?? Date.now()) - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    const locale = currentLang();

    if (diffDays >= maxDays) return date.toLocaleDateString(locale);

    const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style });
    const formatted = dayOnly
      ? relativeTime.format(-diffDays, "day")
      : diffMins < 1
        ? relativeTime.format(0, "second")
        : diffMins < 60
          ? relativeTime.format(-diffMins, "minute")
          : diffHours < 24
            ? relativeTime.format(-diffHours, "hour")
            : relativeTime.format(-diffDays, "day");

    return capitalize
      ? formatted.charAt(0).toUpperCase() + formatted.slice(1)
      : formatted;
  } catch {
    return String(value);
  }
}

/** Day-granular list stamp: "Today", "Yesterday", "3 days ago", then a date. */
export function formatDate(dateString: string | number | Date): string {
  return formatRelativeTime(dateString, { dayOnly: true, maxDays: 7, capitalize: true });
}

/** Absolute calendar date without a time. */
export function formatAbsoluteDate(value: string | number | Date): string {
  try {
    return normalizeTimestamp(value).toLocaleDateString(currentLang(), {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(value);
  }
}

/** Absolute date and time to the minute. */
export function formatDateTime(value: string | number | Date): string {
  try {
    return normalizeTimestamp(value).toLocaleString(currentLang(), {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(value);
  }
}

/** Clock time only, for a stamp whose date is already established. */
export function formatTime(value: string | number | Date): string {
  try {
    return normalizeTimestamp(value).toLocaleTimeString(currentLang(), {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return String(value);
  }
}
