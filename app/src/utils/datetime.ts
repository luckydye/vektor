import { currentLang } from "#utils/lang.ts";
import { normalizeTimestamp } from "#utils/utils.ts";

/**
 * Localized date/time rendering. Kept out of `utils.ts` because `currentLang()`
 * reaches the language catalogues (and, through them, the Vue injection seam),
 * while `utils.ts` is imported by server code on the document/serialization
 * path — see `test/server-frontend-imports.spec.ts`. Timestamp *parsing*
 * (`normalizeTimestamp`) stays in `utils.ts`: it needs no locale.
 */

export type RelativeTimeOptions = {
  /**
   * Wording width: "long" → "5 minutes ago", "short" → "5 min. ago",
   * "narrow" → "5m ago". Defaults to "long".
   */
  style?: "long" | "short" | "narrow";
  /**
   * Once the timestamp is this many days old, render an absolute
   * `toLocaleDateString()` instead of a relative one. Defaults to `Infinity`,
   * i.e. keep counting days forever.
   */
  maxDays?: number;
  /** Round to whole days ("Today", "3 days ago") instead of minutes/hours. */
  dayOnly?: boolean;
  /** Uppercase the first letter — for standalone labels like "Today". */
  capitalize?: boolean;
  /** "Now" in epoch ms. Pass a reactive clock to make the result re-compute. */
  now?: number;
};

/**
 * The single relative-time formatter: localized via `Intl.RelativeTimeFormat`
 * and the current UI language, with an absolute-date fallback for old
 * timestamps. Every "x ago" label in the app goes through here — see
 * `RelativeTimeOptions` for the variants (comment stamps use `narrow`,
 * day-granular list stamps use `formatDate` below).
 *
 * Invalid input degrades to the raw value rather than throwing, because most
 * call sites render this straight into a template.
 */
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
