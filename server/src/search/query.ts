import type { PropertyFilter } from "#api/ApiClient.ts";
import {
  canonicalPropertyKey,
  DATE_FILTER_KEY,
  DOCUMENT_TYPE_FILTER_KEY,
} from "#documents/properties.ts";
import { parseQueryLanguage } from "#utils/queryLanguage.ts";

/**
 * A stretch of the raw query, in input order, for the highlighter to paint.
 * `unsupported` is a well-formed term search cannot apply yet.
 */
export interface QuerySegment {
  text: string;
  kind: "text" | "key" | "separator" | "value" | "unsupported";
}

export interface ParsedQuery {
  /** What is left once the filter terms are lifted out: the full-text part. */
  text: string;
  filters: PropertyFilter[];
  segments: QuerySegment[];
  /** Terms search cannot apply, e.g. comparisons; shown, never silently dropped. */
  unsupported: string[];
}

/**
 * Keys that read something other than a stored property, spelled as the user
 * types them. The parser hands the internal key to the search.
 */
const KEY_ALIASES: Record<string, string> = {
  type: DOCUMENT_TYPE_FILTER_KEY,
  modified: DATE_FILTER_KEY,
};

function unquote(value: string): string {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  const closed = value.length > 1 && value.endsWith(quote);
  return value.slice(1, closed ? -1 : undefined);
}

/**
 * Split a raw search box input into its full-text part and its `key:value`
 * filters (`docs/query-language.md`), plus the segments the box paints.
 *
 * A term with no value yet (`status:`) reads as a filter being typed: painted as
 * one and kept out of the text, but not applied until it has a value. Search
 * applies `key:v` and `key:*`; other terms are painted as unsupported.
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  const parsed = parseQueryLanguage(raw);
  const filters: PropertyFilter[] = [];
  const unsupported = new Set<number>();

  parsed.clauses.forEach((clause, index) => {
    const key = KEY_ALIASES[canonicalPropertyKey(clause.key)] ?? clause.key;
    if (clause.op === "eq") filters.push({ key, value: clause.value.text });
    else if (clause.op === "exists") filters.push({ key, value: null });
    else unsupported.add(index);
  });

  return {
    text: parsed.text,
    filters,
    segments: parsed.segments.map(({ text, kind, clause }) => ({
      text,
      kind: clause !== undefined && unsupported.has(clause) ? "unsupported" : kind,
    })),
    unsupported: [...unsupported].map((index) => parsed.clauses[index]?.term ?? ""),
  };
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
