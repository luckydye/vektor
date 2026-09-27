/**
 * Series filters in the query language (`docs/query-language.md`). Strict: a
 * term that does not parse, or free text, refuses the whole filter.
 */

import { parseQueryLanguage, type QueryValue } from "#utils/queryLanguage.ts";
import { SeriesInputError } from "./limits.ts";
import type { SeriesPredicate } from "./predicates.ts";

const NUMBER = /^-?\d+(\.\d+)?$/;

/** Quoted values stay strings; bare numeric ones are compared as numbers. */
function typed({ text, quoted }: QueryValue): number | string {
  return !quoted && NUMBER.test(text) ? Number(text) : text;
}

export function parseSeriesFilter(text: string): SeriesPredicate[] {
  const parsed = parseQueryLanguage(text);
  const [problem] = parsed.problems;
  if (problem) throw new SeriesInputError(problem);
  if (parsed.text) {
    throw new SeriesInputError(`"${parsed.text}" is not a key:value term`);
  }
  return parsed.clauses.map((clause): SeriesPredicate => {
    const column = clause.key;
    switch (clause.op) {
      case "exists":
        return { column, op: "exists" };
      case "contains":
        return { column, op: "contains", value: clause.value };
      case "in":
        return { column, op: "in", value: clause.values.map(typed) };
      default:
        return { column, op: clause.op, value: typed(clause.value) };
    }
  });
}
