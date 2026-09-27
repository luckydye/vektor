/**
 * The one parser for the query language (`docs/query-language.md`). It is
 * lenient: every surface decides which clauses it honours and whether a
 * problem or free text is an error.
 */

export type QueryValue = { text: string; quoted: boolean };

type QueryClauseBody =
  | { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; value: QueryValue }
  | { op: "in"; values: QueryValue[] }
  | { op: "contains"; value: string }
  | { op: "exists" };

export type QueryClause = { term: string; key: string } & QueryClauseBody;

/** A stretch of the raw query, in input order; `clause` indexes `clauses`. */
export interface QuerySegment {
  text: string;
  kind: "text" | "key" | "separator" | "value";
  clause?: number;
}

export interface ParsedQueryLanguage {
  clauses: QueryClause[];
  /** The words that are not terms, whitespace collapsed. */
  text: string;
  segments: QuerySegment[];
  /** Why a term was not understood, one entry per term. */
  problems: string[];
}

const TERM = /^(-?)([A-Za-z_][A-Za-z0-9_.-]*):(>=|<=|>|<)?(.*)$/s;
const COMPARISONS = { ">": "gt", ">=": "gte", "<": "lt", "<=": "lte" } as const;

/** Words split on whitespace outside double quotes; an open quote runs to the end. */
function words(raw: string): Array<{ text: string; start: number }> {
  const found: Array<{ text: string; start: number }> = [];
  let index = 0;
  while (index < raw.length) {
    if (/\s/.test(raw.charAt(index))) {
      index++;
      continue;
    }
    const start = index;
    let quoted = false;
    while (index < raw.length && (quoted || !/\s/.test(raw.charAt(index)))) {
      if (raw.charAt(index) === '"') quoted = !quoted;
      index++;
    }
    found.push({ text: raw.slice(start, index), start });
  }
  return found;
}

function unquote(text: string): QueryValue {
  if (!text.startsWith('"')) return { text, quoted: false };
  return {
    text: text.slice(1, text.length > 1 && text.endsWith('"') ? -1 : undefined),
    quoted: true,
  };
}

/** Comma-separated values; commas inside quotes belong to the value. */
function splitValues(text: string): QueryValue[] {
  return (text.match(/"[^"]*"?|[^,]+/g) ?? []).map(unquote);
}

type TermResult = { clause: QueryClauseBody } | { problem: string };

function readTerm(
  term: string,
  negate: boolean,
  comparison: string,
  rest: string,
): TermResult {
  if (rest === "") return { problem: `"${term}" has no value` };
  if ((rest.match(/"/g) ?? []).length % 2 !== 0) {
    return { problem: `"${term}" has an unbalanced quote` };
  }
  if (comparison) {
    const values = splitValues(rest);
    const [value] = values;
    if (negate || !value || values.length !== 1) {
      return { problem: `"${term}" compares against exactly one value` };
    }
    return { clause: { op: COMPARISONS[comparison as keyof typeof COMPARISONS], value } };
  }
  if (rest === "*") {
    if (negate) return { problem: `"${term}": a missing key cannot be matched` };
    return { clause: { op: "exists" } };
  }
  if (rest.length > 2 && rest.startsWith("*") && rest.endsWith("*")) {
    if (negate) return { problem: `"${term}": a contains cannot be negated` };
    return { clause: { op: "contains", value: unquote(rest.slice(1, -1)).text } };
  }
  const values = splitValues(rest);
  const [first] = values;
  if (!first) return { problem: `"${term}" has no value` };
  if (values.length > 1) {
    if (negate) return { problem: `"${term}": a list cannot be negated` };
    return { clause: { op: "in", values } };
  }
  return { clause: { op: negate ? "ne" : "eq", value: first } };
}

export function parseQueryLanguage(raw: string): ParsedQueryLanguage {
  const clauses: QueryClause[] = [];
  const problems: string[] = [];
  const segments: QuerySegment[] = [];
  const textWords: string[] = [];
  let plainFrom = 0;

  const flushPlain = (until: number) => {
    if (until > plainFrom)
      segments.push({ text: raw.slice(plainFrom, until), kind: "text" });
  };

  for (const word of words(raw)) {
    const match = TERM.exec(word.text);
    const [, negate = "", key = "", comparison = "", rest = ""] = match ?? [];
    // `https://…` is a word being searched for, not a term on `https`.
    if (!match || rest.startsWith("//")) {
      textWords.push(word.text);
      continue;
    }

    flushPlain(word.start);
    const result = readTerm(word.text, negate === "-", comparison, rest);
    const clause = "clause" in result ? clauses.length : undefined;
    if ("clause" in result) {
      clauses.push({ term: word.text, key, ...result.clause });
    } else {
      problems.push(result.problem);
    }
    segments.push({ text: `${negate}${key}`, kind: "key", clause });
    segments.push({ text: `:${comparison}`, kind: "separator", clause });
    if (rest) segments.push({ text: rest, kind: "value", clause });
    plainFrom = word.start + word.text.length;
  }
  flushPlain(raw.length);

  return { clauses, text: textWords.join(" "), segments, problems };
}
