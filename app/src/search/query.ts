import type { PropertyFilter } from "#api/ApiClient.ts";
import {
  canonicalPropertyKey,
  DATE_FILTER_KEY,
  DOCUMENT_TYPE_FILTER_KEY,
} from "#documents/properties.ts";

/** A stretch of the raw query, in input order, for the highlighter to paint. */
export interface QuerySegment {
  text: string;
  kind: "text" | "key" | "separator" | "value";
}

export interface ParsedQuery {
  /** What is left once the filter terms are lifted out: the full-text part. */
  text: string;
  filters: PropertyFilter[];
  segments: QuerySegment[];
}

/**
 * Keys that read something other than a stored property, spelled as the user
 * types them. The parser hands the internal key to the search.
 */
const KEY_ALIASES: Record<string, string> = {
  type: DOCUMENT_TYPE_FILTER_KEY,
  modified: DATE_FILTER_KEY,
};

/** The value that matches any document carrying the property at all. */
const ANY_VALUE = "*";

/** `key:value`, the value optionally quoted so it can hold spaces. */
const FILTER_TERM = /([A-Za-z_][A-Za-z0-9_.-]*)(:)("[^"]*"?|'[^']*'?|\S*)/g;

function unquote(value: string): string {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  const closed = value.length > 1 && value.endsWith(quote);
  return value.slice(1, closed ? -1 : undefined);
}

/**
 * Split a raw search box input into its full-text part and its `key:value`
 * filters, plus the segments the box paints to tell one from the other.
 *
 * A term with no value yet (`status:`) reads as a filter being typed: painted as
 * one and kept out of the text, but not applied until it has a value.
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const segments: QuerySegment[] = [];
  const filters: PropertyFilter[] = [];
  const textParts: string[] = [];
  let plainFrom = 0;

  const flushPlain = (until: number) => {
    if (until <= plainFrom) return;
    const text = raw.slice(plainFrom, until);
    segments.push({ text, kind: "text" });
    textParts.push(text);
  };

  FILTER_TERM.lastIndex = 0;
  let match = FILTER_TERM.exec(raw);
  while (match !== null) {
    const [term, key, separator, rawValue] = match;
    const start = match.index;
    const startsTerm = start === 0 || /\s/.test(raw[start - 1]);
    // `https://…` is a term being searched for, not a filter on `https`.
    const isUrl = rawValue.startsWith("//");

    if (startsTerm && !isUrl) {
      flushPlain(start);
      segments.push({ text: key, kind: "key" });
      segments.push({ text: separator, kind: "separator" });
      if (rawValue) segments.push({ text: rawValue, kind: "value" });

      const value = unquote(rawValue);
      if (value) {
        filters.push({
          key: KEY_ALIASES[canonicalPropertyKey(key)] ?? key,
          value: value === ANY_VALUE ? null : value,
        });
      }
      plainFrom = start + term.length;
    }

    match = FILTER_TERM.exec(raw);
  }

  flushPlain(raw.length);

  return { text: textParts.join(" ").replace(/\s+/g, " ").trim(), filters, segments };
}

/** The word the caret sits in, split at its colon if it has one. */
export interface QueryTerm {
  start: number;
  end: number;
  /** The filter key being typed, or null while the word is still plain text. */
  key: string | null;
  /** What has been typed of the value, or of the plain word. */
  typed: string;
}

/**
 * The term under the caret, for completing it. Only the word the caret is in or
 * directly after: elsewhere in the query there is nothing to complete.
 */
export function termAtCaret(raw: string, caret: number): QueryTerm | null {
  let start = caret;
  while (start > 0 && !/\s/.test(raw[start - 1])) start -= 1;
  let end = caret;
  while (end < raw.length && !/\s/.test(raw[end])) end += 1;
  if (end === start) return null;

  const word = raw.slice(start, end);
  const colon = word.indexOf(":");
  if (colon === -1) return { start, end, key: null, typed: word };
  return {
    start,
    end,
    key: word.slice(0, colon),
    typed: unquote(word.slice(colon + 1)),
  };
}

/** A value goes back into the query quoted only when it has to be. */
export function formatFilterTerm(key: string, value: string): string {
  return /[\s"']/.test(value) ? `${key}:"${value}"` : `${key}:${value}`;
}

/** The chip filters and the typed ones as one set, duplicates dropped. */
export function mergeFilters(...groups: PropertyFilter[][]): PropertyFilter[] {
  const merged: PropertyFilter[] = [];
  const seen = new Set<string>();
  for (const filter of groups.flat()) {
    const identity = JSON.stringify([canonicalPropertyKey(filter.key), filter.value]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(filter);
  }
  return merged;
}
