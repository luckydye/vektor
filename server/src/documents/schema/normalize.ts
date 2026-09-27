import { markSurvivesSerialization } from "./render.ts";
import {
  type Attrs,
  addMark,
  type DocMark,
  type DocNode,
  defaultAttrs,
  groupMembers,
  HEADING_LEVELS,
  markSpec,
  type NodeSpec,
  nodeSpec,
} from "./specs.ts";

/**
 * Content-model enforcement.
 *
 * This is the piece the pipeline's correctness rests on. The editor's Yjs sync
 * plugin does not throw on schema-invalid content — it *deletes the offending
 * item* (`y-prosemirror`'s `createNodeFromYElement` catches the failure and
 * removes the Y item). Invalid server output is therefore silent data loss on
 * the first client that opens the room, not a visible error, so everything the
 * server writes is made valid here first.
 *
 * The rules are not hand-written per node: they fall out of the `content`
 * expression in the spec table, the same way ProseMirror derives them.
 */

// ---------------------------------------------------------------------------
// Content expressions
// ---------------------------------------------------------------------------

interface Term {
  /** Node names this term accepts, groups already expanded. */
  options: string[];
  min: number;
  max: number;
}

const termCache = new Map<string, Term[]>();

/**
 * Parses the subset of ProseMirror content expressions the schema uses: a
 * sequence of terms, each a node name or a `(a | b)` choice, optionally
 * quantified with `+`, `*` or `?`.
 */
export function contentTerms(expression: string | undefined): Term[] {
  if (!expression) return [];
  const cached = termCache.get(expression);
  if (cached) return cached;

  const terms: Term[] = [];
  for (const token of expression.match(/\([^)]*\)[+*?]?|[^\s()]+/g) ?? []) {
    const quantifier = /[+*?]$/.test(token) ? token.slice(-1) : "";
    const body = (quantifier ? token.slice(0, -1) : token).replace(/^\(|\)$/g, "");
    const names = body
      .split("|")
      .map((name) => name.trim())
      .filter(Boolean);
    terms.push({
      options: names.flatMap((name) => (nodeSpec(name) ? [name] : groupMembers(name))),
      min: quantifier === "*" || quantifier === "?" ? 0 : 1,
      max: quantifier === "+" || quantifier === "*" ? Number.POSITIVE_INFINITY : 1,
    });
  }

  termCache.set(expression, terms);
  return terms;
}

function accepts(terms: Term[], name: string): boolean {
  return terms.some((term) => term.options.includes(name));
}

// ---------------------------------------------------------------------------
// Building valid nodes out of thin air
// ---------------------------------------------------------------------------

/** The node a term is filled with when it is required but nothing matched. */
function preferredOption(options: string[]): string | undefined {
  return options.includes("paragraph") ? "paragraph" : options[0];
}

/** An empty, valid instance of `name` — its required content filled in too. */
function emptyNode(name: string, depth = 0): DocNode | null {
  const spec = nodeSpec(name);
  if (!spec || depth > 4) return null;

  const node: DocNode = { type: name };
  const attrs = defaultAttrs(spec);
  if (Object.keys(attrs).length > 0) node.attrs = attrs;
  const content: DocNode[] = [];
  for (const term of contentTerms(spec.content)) {
    for (let i = 0; i < term.min; i++) {
      const option = preferredOption(term.options);
      const child = option ? emptyNode(option, depth + 1) : null;
      if (child) content.push(child);
    }
  }
  if (content.length > 0) node.content = content;
  return node;
}

/**
 * The shortest chain of wrapper nodes that lets `name` sit inside one of
 * `options` — `["paragraph"]` for a bare text node at block level,
 * `["table", "tableRow"]` for a stray `<td>`. ProseMirror's `findWrapping`,
 * bounded to the depths this schema actually needs.
 */
function findWrapping(options: string[], name: string): string[] | null {
  const seen = new Set<string>();
  let frontier: string[][] = options.map((option) => [option]);

  for (let depth = 0; depth < 3 && frontier.length > 0; depth++) {
    const next: string[][] = [];
    for (const chain of frontier) {
      const candidate = chain[chain.length - 1] as string;
      if (seen.has(candidate)) continue;
      seen.add(candidate);

      const spec = nodeSpec(candidate);
      if (!spec?.content) continue;
      const terms = contentTerms(spec.content);
      if (accepts(terms, name)) return chain;
      for (const option of terms[0]?.options ?? []) next.push([...chain, option]);
    }
    frontier = next;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fitting children to a content expression
// ---------------------------------------------------------------------------

/**
 * Walks `children` against `terms`, repairing anything that does not fit:
 * wrapping a child that needs a container, filling a required term that nothing
 * matched, and dropping what neither can rescue. Valid content passes through
 * untouched.
 */
function fitContent(terms: Term[], children: DocNode[], depth: number): DocNode[] {
  if (terms.length === 0) return [];

  const out: DocNode[] = [];
  /**
   * Wrappers this pass invented. They are normalized again at the end: a
   * wrapper is chosen because it *can* hold the child somewhere, which is not
   * the same as the child being valid where it landed — a code block goes in a
   * list item, but only after the paragraph the item has to start with.
   */
  const created = new Set<DocNode>();
  let index = 0;
  let used = 0;
  /**
   * The wrapper chain built for the child just placed, so a run of children
   * needing the same one shares it instead of getting a wrapper each. Empty
   * whenever the last child went in directly; when it is set, the wrapper is
   * the last node in `out`.
   */
  let openChain = "";

  /** Advances to the term accepting `child`, or reports that none can. */
  const place = (child: DocNode): boolean => {
    let term = index;
    let count = used;
    while (term < terms.length) {
      const current = terms[term] as Term;
      if (count < current.max && current.options.includes(child.type)) {
        index = term;
        used = count + 1;
        out.push(child);
        return true;
      }
      if (count < current.min) return false;
      term++;
      count = 0;
    }
    return false;
  };

  /**
   * Node types that can still be placed here. A term that has not met its
   * minimum blocks everything after it — a list item's leading paragraph is not
   * optional, so a heading must not be wrapped into whatever the *later* term
   * would have taken.
   */
  const reachable = (): string[] => {
    const options: string[] = [];
    let count = used;
    for (let term = index; term < terms.length; term++) {
      const current = terms[term] as Term;
      if (count < current.max) options.push(...current.options);
      if (count < current.min) break;
      count = 0;
    }
    return options;
  };

  for (const child of children) {
    const previousChain = openChain;
    openChain = "";
    if (place(child)) continue;

    const wrapping = findWrapping(reachable(), child.type);
    if (wrapping) {
      const chain = wrapping.join(">");
      const reopened =
        previousChain === chain ? innermost(out[out.length - 1], wrapping.length) : null;
      if (reopened) {
        reopened.content?.push(child);
        openChain = chain;
        continue;
      }
      const wrapper = buildWrapper(wrapping, child);
      if (wrapper && place(wrapper)) {
        created.add(wrapper);
        openChain = chain;
        continue;
      }
    }

    // The current term is required and nothing matched it — a list item whose
    // first child is not a paragraph, say. Fill it, then retry the child.
    const required = terms[index];
    if (required && used < required.min) {
      const filler = preferredOption(required.options);
      const node = filler ? emptyNode(filler) : null;
      if (node && place(node) && place(child)) continue;
    }
    // Nothing can hold it. Dropping is the last resort, and it is still better
    // than emitting content the editor would delete on load.
  }

  for (let term = index; term < terms.length; term++) {
    const current = terms[term] as Term;
    const already = term === index ? used : 0;
    for (let i = already; i < current.min; i++) {
      const option = preferredOption(current.options);
      const node = option ? emptyNode(option) : null;
      if (node) out.push(node);
    }
  }

  return out.map((node) =>
    created.has(node) ? (normalizeNode(node, depth) ?? node) : node,
  );
}

/** Builds the wrapper chain around `child`, outermost node returned. */
function buildWrapper(chain: string[], child: DocNode): DocNode | null {
  let node: DocNode | null = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const spec = nodeSpec(chain[i] as string);
    if (!spec) return null;
    const attrs = defaultAttrs(spec);
    const wrapper: DocNode = { type: spec.name };
    if (Object.keys(attrs).length > 0) wrapper.attrs = attrs;
    wrapper.content = [node ?? child];
    node = wrapper;
  }
  return node;
}

/**
 * The innermost node of a wrapper chain `depth` nodes deep — the one a
 * following child of the same shape is appended to. Every node above it holds
 * exactly the one child, so descending the first child each time finds it.
 */
function innermost(node: DocNode | undefined, depth: number): DocNode | null {
  let current = node;
  for (let level = 1; level < depth; level++) current = current?.content?.[0];
  return current ?? null;
}

// ---------------------------------------------------------------------------
// Normalizing a tree
// ---------------------------------------------------------------------------

export function normalizeDocument(doc: DocNode): DocNode {
  return (
    normalizeNode(doc) ?? {
      type: "doc",
      content: [emptyNode("paragraph") as DocNode],
    }
  );
}

function normalizeNode(node: DocNode, depth = 0): DocNode | null {
  if (node.type === "text") {
    if (!node.text) return null;
    const marks = normalizeMarks(node.marks);
    return marks ? { ...node, marks } : withoutMarks(node);
  }

  const spec = nodeSpec(node.type);
  if (!spec || depth > 64) return null;

  const result: DocNode = { type: node.type };
  const attrs = normalizeAttrs(spec, node.attrs);
  if (attrs) result.attrs = attrs;
  const marks = spec.inline ? normalizeMarks(node.marks) : undefined;
  if (marks) result.marks = marks;

  const terms = contentTerms(spec.content);
  if (terms.length === 0) return result;

  let children = (node.content ?? [])
    .map((child) => normalizeNode(child, depth + 1))
    .filter((child): child is DocNode => child !== null);

  // A block node inside an inline-only parent has no valid position; keep its
  // inline content rather than dropping the text with it.
  const inlineContent = accepts(terms, "text");
  if (inlineContent) children = children.flatMap(inlineContentOf);
  if (spec.marks === "") children = children.map(withoutMarks);
  if (!spec.verbatim) children = collapseWhitespace(children, inlineContent);

  const content = mergeText(fitContent(terms, children, depth + 1));
  if (content.length > 0) result.content = content;
  return result;
}

/**
 * Drops marks the schema does not know and re-applies the exclusion rules, so a
 * pair that cannot coexist never reaches the encoder. `undefined` means "no
 * marks", which is how a text node with none is written.
 */
function normalizeMarks(marks: DocMark[] | undefined): DocMark[] | undefined {
  if (!marks?.length) return undefined;
  let set: DocMark[] = [];
  for (const mark of marks) {
    if (markSpec(mark.type) && markSurvivesSerialization(mark)) set = addMark(set, mark);
  }
  return set.length > 0 ? set : undefined;
}

function normalizeAttrs(spec: NodeSpec, attrs: Attrs | undefined): Attrs | undefined {
  if (!spec.attrs) return undefined;
  const normalized: Attrs = { ...defaultAttrs(spec), ...(attrs ?? {}) };
  for (const key of Object.keys(normalized)) {
    if (!(key in spec.attrs)) delete normalized[key];
  }
  if (spec.name === "heading") {
    const level = Number(normalized.level);
    normalized.level = HEADING_LEVELS.includes(level) ? level : HEADING_LEVELS[0];
  }
  return normalized;
}

/** The inline content of a node, for hoisting it into an inline-only parent. */
function inlineContentOf(node: DocNode): DocNode[] {
  if (node.type === "text") return [node];
  const spec = nodeSpec(node.type);
  if (spec?.inline) return [node];
  return (node.content ?? []).flatMap(inlineContentOf);
}

function withoutMarks(node: DocNode): DocNode {
  if (!node.marks) return node;
  const { marks: _dropped, ...rest } = node;
  return rest;
}

/**
 * Collapses whitespace in text the way an HTML parser does: runs become one
 * space, and a leading space is dropped where a text run starts — at the very
 * beginning, after a hard break, after text that already ends in a space, or at
 * a block position after a block, because a fresh paragraph opens there.
 *
 * It runs here rather than in the parser because text hoisted out of a code
 * block — where whitespace *was* significant — lands in a paragraph, and
 * whitespace that survives into the HTML would be collapsed by the next parse,
 * leaving the document different after a round trip than before it.
 */
function collapseWhitespace(children: DocNode[], inline: boolean): DocNode[] {
  const out: DocNode[] = [];
  for (const child of children) {
    if (child.type !== "text") {
      out.push(child);
      continue;
    }
    let text = (child.text ?? "").replace(/[ \t\r\n\f]+/g, " ");
    if (text.startsWith(" ") && startsTextRun(out[out.length - 1], inline)) {
      text = text.slice(1);
    }
    if (text) out.push({ ...child, text });
  }
  return out;
}

function startsTextRun(previous: DocNode | undefined, inline: boolean): boolean {
  if (!previous) return true;
  if (previous.type === "hardBreak") return true;
  if (previous.type === "text") return (previous.text ?? "").endsWith(" ");
  return !inline && !nodeSpec(previous.type)?.inline;
}

/**
 * Merges adjacent text nodes carrying identical marks, as a ProseMirror
 * fragment does. The Y encoder writes one `Y.XmlText` per run of text nodes and
 * one delta per node, so an unmerged pair would produce different Y state for
 * the same document.
 */
function mergeText(children: DocNode[]): DocNode[] {
  const out: DocNode[] = [];
  for (const child of children) {
    const previous = out[out.length - 1];
    if (
      child.type === "text" &&
      previous?.type === "text" &&
      sameMarks(previous.marks, child.marks)
    ) {
      previous.text = (previous.text ?? "") + (child.text ?? "");
      continue;
    }
    out.push(child);
  }
  return out.filter((child) => child.type !== "text" || child.text);
}

function sameMarks(a: DocMark[] | undefined, b: DocMark[] | undefined): boolean {
  const left = a ?? [];
  const right = b ?? [];
  if (left.length !== right.length) return false;
  return left.every(
    (mark, index) =>
      mark.type === right[index]?.type &&
      JSON.stringify(markAttrsOf(mark)) === JSON.stringify(markAttrsOf(right[index])),
  );
}

function markAttrsOf(mark: DocMark | undefined): Attrs {
  if (!mark) return {};
  const spec = markSpec(mark.type);
  return { ...(spec ? defaultAttrs(spec) : {}), ...(mark.attrs ?? {}) };
}
