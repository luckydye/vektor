/**
 * Which inputs a workflow script expects.
 *
 * A workflow script has no manifest — it reads whatever it wants off the
 * `input` global — so the fields are recovered from the source. That is what
 * lets the UI ask for the values before a run instead of starting one that
 * fails on the first missing input. The run button reads the script off the
 * document and scans it here, in the browser; nothing about this needs a server.
 *
 * The scan is deliberately syntactic and forgiving: a name it misses only costs
 * the prompt one field, and a name it invents costs one optional field nobody
 * fills. Anything it cannot see (a computed key, the whole `input` object handed
 * to another function) is simply not offered.
 */
/**
 * What the prompt should show for a field. There is nothing to read this off but
 * the name — a script asking for `file` wants a URL it can fetch, and one asking
 * for `docId` wants a document id — so the name is the convention.
 */
export type WorkflowInputKind = "text" | "file" | "document";

export interface WorkflowInputField {
  name: string;
  /** The script reads it with no fallback, so a run without it cannot work. */
  required: boolean;
  kind: WorkflowInputKind;
}

/** `docId`, `documentId`, `targetDocumentId` — but not `docIdList`. */
const DOCUMENT_INPUT = /doc(ument)?id$/i;
/**
 * `file`, `csvFile`, `source_file` — the camel/snake boundary is what keeps
 * `profile` out.
 */
const FILE_INPUT = /^file$|[_-]file$|[a-z0-9]File$/;

export function workflowInputKind(name: string): WorkflowInputKind {
  if (DOCUMENT_INPUT.test(name)) return "document";
  if (FILE_INPUT.test(name)) return "file";
  return "text";
}

/**
 * Drop comments while leaving string and template literals intact — a bracket
 * access carries its key in a string, and a `"https://…"` inside one must not
 * read as the start of a line comment.
 */
function stripComments(code: string): string {
  let out = "";
  let index = 0;
  while (index < code.length) {
    const char = code[index];
    if (char === '"' || char === "'" || char === "`") {
      out += char;
      index++;
      while (index < code.length) {
        if (code[index] === "\\") {
          out += code.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += code[index];
        index++;
        if (code[index - 1] === char) break;
      }
      continue;
    }
    if (char === "/" && code[index + 1] === "/") {
      while (index < code.length && code[index] !== "\n") index++;
      continue;
    }
    if (char === "/" && code[index + 1] === "*") {
      index += 2;
      while (index < code.length && !(code[index] === "*" && code[index + 1] === "/")) {
        index++;
      }
      index += 2;
      continue;
    }
    out += char;
    index++;
  }
  return out;
}

/** `input.name` / `input?.name` */
const DOT_ACCESS = /\binput\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g;
/** `input["name"]` / `input?.["name"]` */
const BRACKET_ACCESS = /\binput\s*(?:\?\.)?\[\s*(["'`])([^"'`]+)\1\s*\]/g;
/** `const { a, b } = input` */
const DESTRUCTURING = /(?:const|let|var)\s*\{([^{}]*)\}\s*=\s*input\b/g;

/** A `??` or `||` right after the read: the script has its own fallback. */
const FALLBACK_AFTER = /^\s*(?:\?\?|\|\|)/;

/** Split a destructuring pattern on its top-level commas. */
function splitPatternEntries(pattern: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") depth--;
    else if (char === "," && depth === 0) {
      entries.push(pattern.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(pattern.slice(start));
  return entries;
}

export function parseWorkflowInputFields(code: string): WorkflowInputField[] {
  const source = stripComments(code);
  // A fallback anywhere makes the field optional — one read that can cope
  // without a value is enough for the script to run. The prompt is ordered by
  // where the script first reads each name, so the form reads like the script:
  // the patterns are scanned one after another, which is not source order.
  const fields = new Map<string, { name: string; required: boolean; at: number }>();

  const record = (name: string, required: boolean, at: number) => {
    const existing = fields.get(name);
    if (!existing) {
      fields.set(name, { name, required, at });
      return;
    }
    existing.required = existing.required && required;
    existing.at = Math.min(existing.at, at);
  };

  for (const match of source.matchAll(DOT_ACCESS)) {
    const at = match.index ?? 0;
    record(match[1], !FALLBACK_AFTER.test(source.slice(at + match[0].length)), at);
  }

  for (const match of source.matchAll(BRACKET_ACCESS)) {
    const at = match.index ?? 0;
    record(match[2], !FALLBACK_AFTER.test(source.slice(at + match[0].length)), at);
  }

  for (const match of source.matchAll(DESTRUCTURING)) {
    for (const entry of splitPatternEntries(match[1])) {
      const trimmed = entry.trim();
      if (!trimmed || trimmed.startsWith("...")) continue;
      const name = trimmed.split(/[:=]/)[0].trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
      record(name, !trimmed.includes("="), match.index ?? 0);
    }
  }

  return [...fields.values()]
    .sort((a, b) => a.at - b.at)
    .map(({ name, required }) => ({ name, required, kind: workflowInputKind(name) }));
}
