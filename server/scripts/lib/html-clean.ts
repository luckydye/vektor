/**
 * Rendered export HTML -> HTML the document schema can hold.
 *
 * Both a Confluence and an XWiki HTML export are a full skinned page: the body
 * is real HTML, but wrapped in layers of presentational `<div>`s and carrying
 * macro output as CSS classes. Three things make that unusable as-is.
 *
 * Any block tag the schema has no node for is captured *verbatim* as an
 * `htmlBlock` (see `HTML_BLOCK_TAGS`), so a leftover `<div class="innerCell">`
 * does not degrade to a wrong-looking paragraph — it freezes a chunk of export
 * scaffolding into the document as opaque markup. Every wrapper therefore has to
 * be resolved here, not left to the parser.
 *
 * This schema has no inline image and no inline code block, so an `<img>` inside
 * a `<p>` is *dropped* on parse rather than moved. Confluence puts every image
 * inside a paragraph, so blocks are lifted out of inline containers below.
 *
 * And `htmlToDoc` decodes only a handful of named entities, so `H&ouml;lzinger`
 * would be stored as those literal eight characters. Entities are therefore
 * decoded on the way in and re-escaped on the way out, and anything not in the
 * table is reported rather than passed through.
 *
 * The rewriting is a tree walk with a per-format rule callback, because deciding
 * what a `<div class="task-macro">` means is the one part that differs between
 * exports.
 */

import { type HtmlNode, type HtmlTagNode, parseHtml, SyntaxKind } from "#utils/html.ts";

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/**
 * Named entities these exports use, plus the rest of the set a wiki plausibly
 * emits. Deliberately not exhaustive: an entity that is missing gets counted and
 * shows up in the report, which is how the list was arrived at in the first
 * place.
 */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  times: "×",
  divide: "÷",
  minus: "−",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  bull: "•",
  middot: "·",
  deg: "°",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  sect: "§",
  para: "¶",
  dagger: "†",
  permil: "‰",
  prime: "′",
  Prime: "″",
  larr: "←",
  rarr: "→",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  rArr: "⇒",
  hArr: "⇔",
  le: "≤",
  ge: "≥",
  ne: "≠",
  asymp: "≈",
  plusmn: "±",
  sup2: "²",
  sup3: "³",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  micro: "µ",
  auml: "ä",
  ouml: "ö",
  uuml: "ü",
  Auml: "Ä",
  Ouml: "Ö",
  Uuml: "Ü",
  szlig: "ß",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  atilde: "ã",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  egrave: "è",
  eacute: "é",
  ecirc: "ê",
  euml: "ë",
  igrave: "ì",
  iacute: "í",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  ograve: "ò",
  oacute: "ó",
  ocirc: "ô",
  otilde: "õ",
  oslash: "ø",
  ugrave: "ù",
  uacute: "ú",
  ucirc: "û",
  yacute: "ý",
  yuml: "ÿ",
  Agrave: "À",
  Aacute: "Á",
  Acirc: "Â",
  Aring: "Å",
  AElig: "Æ",
  Ccedil: "Ç",
  Egrave: "È",
  Eacute: "É",
  Ecirc: "Ê",
  Euml: "Ë",
  Iacute: "Í",
  Ntilde: "Ñ",
  Oacute: "Ó",
  Ocirc: "Ô",
  Oslash: "Ø",
  Uacute: "Ú",
  shy: "­",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  zwnj: "‌",
  zwj: "‍",
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  pi: "π",
  sigma: "σ",
  omega: "ω",
  Omega: "Ω",
  infin: "∞",
  radic: "√",
  sum: "∑",
  prod: "∏",
  part: "∂",
  int: "∫",
  ldquor: "„",
  spades: "♠",
  hearts: "♥",
  clubs: "♣",
  diams: "♦",
  star: "☆",
  check: "✓",
  cross: "✗",
};

const ENTITY = /&(?:#x([\da-fA-F]+)|#(\d+)|([a-zA-Z][a-zA-Z0-9]{1,10}));/g;

/** Named entities that were left as-is because the table has no entry. */
export const unknownEntities = new Map<string, number>();

/** Source text -> the characters it stands for. */
export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(ENTITY, (match, hex, decimal, name) => {
    if (hex !== undefined) return codePoint(Number.parseInt(hex, 16), match);
    if (decimal !== undefined) return codePoint(Number.parseInt(decimal, 10), match);
    const character = ENTITIES[name];
    if (character !== undefined) return character;
    unknownEntities.set(name, (unknownEntities.get(name) ?? 0) + 1);
    return match;
  });
}

function codePoint(value: number, match: string): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff) return match;
  try {
    return String.fromCodePoint(value);
  } catch {
    return match;
  }
}

/** Characters -> HTML text. Attribute values additionally need the quote out. */
function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}

// ---------------------------------------------------------------------------
// Tag classification
// ---------------------------------------------------------------------------

/** Marks and inline nodes: allowed inside a paragraph. */
const INLINE = new Set([
  "a",
  "b",
  "code",
  "date-picker",
  "del",
  "document-mention",
  "em",
  "i",
  "ins",
  "s",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "ticket-link",
  "u",
  "user-mention",
]);

/** Blocks whose content is inline, so a block child has to be lifted out. */
const INLINE_CONTENT = new Set(["p", "h1", "h2", "h3", "h4"]);

/** Blocks whose content is other blocks, so a bare text child needs wrapping. */
const BLOCK_CONTENT = new Set(["blockquote", "div", "li", "td", "th"]);

/** Tags kept for structure alone; their children carry the content model. */
const STRUCTURAL = new Set(["ol", "table", "tbody", "tfoot", "thead", "tr", "ul"]);

const VOID_BLOCK = new Set(["file-attachment", "figma-embed", "hr", "img", "video"]);

/**
 * Tags unwrapped by design, so they are not counted as content that lost its
 * framing: column widths are rebuilt by the table renderer from the cells, and
 * `<font>`/`<center>` say nothing the schema's marks do not.
 */
const EXPECTED_UNWRAP = new Set(["col", "colgroup", "center", "font", "tt", "nobr"]);

/** Never content, whatever they contain. */
const DISCARD = new Set([
  "button",
  "form",
  "head",
  "input",
  "label",
  "link",
  "meta",
  "noscript",
  "option",
  "script",
  "select",
  "style",
  "svg",
  "textarea",
  "title",
]);

// ---------------------------------------------------------------------------
// Attribute policy
// ---------------------------------------------------------------------------

/**
 * Attributes kept per tag. Everything else goes: an export carries dozens of
 * `data-linked-resource-*` and `aui-*` attributes per element, none of which the
 * schema reads, and all of which would be stored on every document forever.
 */
const KEEP_ATTRS: Record<string, string[]> = {
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height"],
  video: ["src", "width", "height"],
  "file-attachment": ["src", "filename"],
  "user-mention": ["email"],
  "date-picker": ["data-date"],
  "ticket-link": ["data-ticket-id"],
  "document-mention": ["data-document-id", "data-href"],
  span: ["style"],
  p: ["style"],
  h1: ["style"],
  h2: ["style"],
  h3: ["style"],
  h4: ["style"],
  td: ["colspan", "rowspan", "style"],
  th: ["colspan", "rowspan", "style"],
  ol: ["start"],
  ul: ["data-type"],
  li: ["data-type", "data-checked"],
  div: ["data-type", "data-columns"],
};

/** Style declarations the schema reads; the rest is export theming. */
const KEEP_STYLES = new Set(["color", "background-color", "text-align"]);

function filterStyle(value: string): string {
  const kept: string[] = [];
  for (const declaration of value.split(";")) {
    const [property, ...rest] = declaration.split(":");
    const name = property?.trim().toLowerCase();
    const setting = rest.join(":").trim();
    if (!name || !setting || !KEEP_STYLES.has(name)) continue;
    // A `transparent` background carries no meaning here and `inherit` actively
    // fights the theme.
    if (/^(inherit|initial|unset|transparent|currentcolor|none)$/i.test(setting))
      continue;
    kept.push(`${name}: ${setting}`);
  }
  return kept.join("; ");
}

function renderAttrs(tag: string, attrs: Map<string, string>): string {
  const allowed = KEEP_ATTRS[tag];
  if (!allowed) return "";

  const parts: string[] = [];
  for (const name of allowed) {
    let value = attrs.get(name);
    if (value === undefined) continue;
    if (name === "style") value = filterStyle(value);
    // A height without a width is an export rendering hint — Confluence sizes
    // its attachment tiles that way — and forcing it would distort the image.
    if (
      (name === "height" || name === "width") &&
      !(attrs.get("width") && attrs.get("height"))
    ) {
      continue;
    }
    if (!value) continue;
    parts.push(` ${name}="${escapeAttr(value)}"`);
  }
  return parts.join("");
}

// ---------------------------------------------------------------------------
// Rule interface
// ---------------------------------------------------------------------------

export interface Element {
  tag: string;
  classes: Set<string>;
  /** Attribute value with entities already decoded. */
  attr(name: string): string | null;
  /** Plain text of the whole subtree, decoded. */
  text(): string;
  /** The subtree converted by the same rules, as block-level HTML. */
  inner(): string;
  /** The subtree converted by the same rules, as inline HTML. */
  innerInline(): string;
  /** Child elements, for a rule that has to rebuild a structure from them. */
  childElements(): Element[];
  /** Descendant elements matching `match`, outermost first. */
  find(match: (el: Element) => boolean): Element[];
  children: HtmlNode[];
}

export type Action =
  /** Element and everything in it goes away. */
  | "drop"
  /** Element goes, its children are converted in its place. */
  | "unwrap"
  /** Element becomes a different tag; children are converted as usual. */
  | { tag: string; attrs?: Record<string, string> }
  /** Finished HTML, spliced in without further conversion. */
  | { inline: string }
  | { block: string }
  /** Default handling. */
  | null;

export type Rule = (el: Element) => Action;

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

interface Piece {
  block: boolean;
  html: string;
}

export interface CleanResult {
  html: string;
  /** Tags unwrapped because the schema has no node for them, by tag name. */
  unwrapped: Map<string, number>;
  /** Tags discarded with their content, by tag name. */
  discarded: Map<string, number>;
}

/**
 * Converts export HTML into schema-shaped HTML.
 *
 * `rule` sees every element before the defaults do and decides what a
 * format-specific wrapper or macro means; returning null falls through to the
 * generic handling.
 */
export function cleanHtml(html: string, rule: Rule): CleanResult {
  const unwrapped = new Map<string, number>();
  const discarded = new Map<string, number>();
  const count = (into: Map<string, number>, tag: string): void => {
    into.set(tag, (into.get(tag) ?? 0) + 1);
  };

  const textOf = (nodes: HtmlNode[]): string =>
    nodes
      .map((node) => {
        if (node.type === SyntaxKind.Text) return decodeEntities(node.value);
        const tag = node as HtmlTagNode;
        return tag.body ? textOf(tag.body) : "";
      })
      .join("");

  const convert = (nodes: HtmlNode[]): Piece[] => {
    const pieces: Piece[] = [];
    for (const node of nodes) {
      if (node.type === SyntaxKind.Text) {
        const text = decodeEntities(node.value);
        if (text.trim()) pieces.push({ block: false, html: escapeText(text) });
        // Whitespace between two inline runs is meaningful; between blocks it is
        // export indentation and only inflates the document.
        else if (text && pieces.at(-1)?.block === false) {
          pieces.push({ block: false, html: " " });
        }
        continue;
      }
      if (node.type === SyntaxKind.Tag) pieces.push(...convertTag(node as HtmlTagNode));
    }
    return pieces;
  };

  /** Groups pieces into blocks, wrapping loose inline runs in a paragraph. */
  const asBlocks = (pieces: Piece[]): string => {
    const out: string[] = [];
    let run: string[] = [];
    const flush = (): void => {
      const inline = run.join("").trim();
      run = [];
      if (inline) out.push(`<p>${inline}</p>`);
    };
    for (const piece of pieces) {
      if (piece.block) {
        flush();
        out.push(piece.html);
      } else run.push(piece.html);
    }
    flush();
    return out.join("");
  };

  /**
   * Serializes a container, splitting it wherever a block child turned up inside
   * it. `<p>text <img></p>` has to become `<p>text</p><img>` because the schema
   * has no inline image and would otherwise drop it.
   *
   * `wrapEmpty` keeps a genuinely empty paragraph from being invented, while
   * still letting an inline wrapper like `<strong>` disappear when it holds
   * nothing.
   */
  const split = (
    tag: string,
    attrs: string,
    pieces: Piece[],
    asBlock: boolean,
  ): Piece[] => {
    const out: Piece[] = [];
    let run: string[] = [];
    const flush = (): void => {
      const inline = asBlock ? run.join("").trim() : run.join("");
      run = [];
      if (inline.trim()) {
        out.push({ block: asBlock, html: `<${tag}${attrs}>${inline}</${tag}>` });
      }
    };
    for (const piece of pieces) {
      if (piece.block) {
        flush();
        out.push(piece);
      } else run.push(piece.html);
    }
    flush();
    return out;
  };

  function elementFor(node: HtmlTagNode): {
    element: Element;
    attrs: Map<string, string>;
  } {
    const attrs = new Map<string, string>();
    for (const attribute of node.attributes ?? []) {
      attrs.set(
        attribute.name.value.toLowerCase(),
        decodeEntities(attribute.value?.value ?? ""),
      );
    }
    const body = node.body ?? [];
    const element: Element = {
      tag: node.name.toLowerCase(),
      classes: new Set(
        (attrs.get("class") ?? "").split(/\s+/).filter((entry) => entry.length > 0),
      ),
      attr: (key) => attrs.get(key) ?? null,
      text: () => textOf(body),
      inner: () => asBlocks(convert(body)),
      innerInline: () =>
        convert(body)
          .map((piece) => piece.html)
          .join(""),
      childElements: () =>
        body
          .filter((child) => child.type === SyntaxKind.Tag)
          .map((child) => elementFor(child as HtmlTagNode).element),
      find: (match) => {
        const found: Element[] = [];
        const walk = (children: Element[]): void => {
          for (const child of children) {
            if (match(child)) found.push(child);
            else walk(child.childElements());
          }
        };
        walk(element.childElements());
        return found;
      },
      children: body,
    };
    return { element, attrs };
  }

  function convertTag(node: HtmlTagNode): Piece[] {
    const name = node.name.toLowerCase();
    // Comments and declarations are not content.
    if (name.startsWith("!")) return [];

    const { element, attrs } = elementFor(node);
    const body = node.body ?? [];

    let tag = name;
    const action = rule(element);
    if (action === "drop") return [];
    if (action === "unwrap") return convert(body);
    if (action && typeof action === "object") {
      if ("inline" in action) {
        return action.inline ? [{ block: false, html: action.inline }] : [];
      }
      if ("block" in action) {
        return action.block ? [{ block: true, html: action.block }] : [];
      }
      tag = action.tag;
      for (const [key, value] of Object.entries(action.attrs ?? {}))
        attrs.set(key, value);
    }

    if (DISCARD.has(tag)) {
      count(discarded, tag);
      return [];
    }
    // Headings deeper than the schema's four levels flatten to the last one
    // rather than becoming paragraphs.
    if (tag === "h5" || tag === "h6") tag = "h4";

    const rendered = renderAttrs(tag, attrs);

    if (tag === "pre") {
      const language = attrs.get("data-language");
      const open = language
        ? `<pre><code class="language-${escapeAttr(language)}">`
        : "<pre><code>";
      const code = textOf(body);
      return code.trim()
        ? [{ block: true, html: `${open}${escapeText(code)}</code></pre>` }]
        : [];
    }
    if (VOID_BLOCK.has(tag)) return [{ block: true, html: `<${tag}${rendered}>` }];
    if (tag === "br") return [{ block: false, html: "<br>" }];
    if (INLINE.has(tag)) return split(tag, rendered, convert(body), false);
    if (INLINE_CONTENT.has(tag)) return split(tag, rendered, convert(body), true);
    if (STRUCTURAL.has(tag)) {
      const inner = convert(body)
        .map((piece) => piece.html)
        .join("");
      return inner.trim()
        ? [{ block: true, html: `<${tag}${rendered}>${inner}</${tag}>` }]
        : [];
    }
    if (BLOCK_CONTENT.has(tag)) {
      // A bare `<div>` carries no meaning the schema keeps — only a layout div,
      // which a rule has already retagged with its `data-type`.
      if (tag === "div" && !attrs.get("data-type")) {
        count(unwrapped, "div");
        return convert(body);
      }
      const inner = asBlocks(convert(body));
      if (!inner && tag !== "td" && tag !== "th") return [];
      return [{ block: true, html: `<${tag}${rendered}>${inner}</${tag}>` }];
    }

    // Nothing claims it: keep the content, lose the element.
    if (!EXPECTED_UNWRAP.has(tag)) count(unwrapped, tag);
    return convert(body);
  }

  return { html: asBlocks(convert(parseHtml(html))), unwrapped, discarded };
}

// ---------------------------------------------------------------------------
// Shared macro output
// ---------------------------------------------------------------------------

/**
 * Confluence status badge colours as a foreground/background pair, fixed on both
 * halves so a badge stays legible whatever it is sitting on.
 *
 * Both exports need these: the XWiki wiki was migrated off Confluence and its
 * pages still carry `aui-lozenge` markup.
 */
const LOZENGE_COLOURS: Record<string, [string, string]> = {
  success: ["#dcfce7", "#166534"],
  green: ["#dcfce7", "#166534"],
  error: ["#fee2e2", "#991b1b"],
  red: ["#fee2e2", "#991b1b"],
  current: ["#dbeafe", "#1e40af"],
  complete: ["#dbeafe", "#1e40af"],
  blue: ["#dbeafe", "#1e40af"],
  moved: ["#fef9c3", "#854d0e"],
  yellow: ["#fef9c3", "#854d0e"],
  default: ["#e5e7eb", "#374151"],
  grey: ["#e5e7eb", "#374151"],
};

/** A status badge; the schema keeps the colour as a `textStyle` mark. */
export function lozenge(names: Iterable<string>, label: string): string {
  const named = [...names]
    .map((entry) =>
      entry
        .replace(/^aui-lozenge-/, "")
        .replace(/Status$/, "")
        .toLowerCase(),
    )
    .find((entry) => entry in LOZENGE_COLOURS);
  const [background, foreground] = LOZENGE_COLOURS[named ?? "default"];
  return `<span style="background-color: ${background}; color: ${foreground}">${escapeText(label.trim())}</span>`;
}

/**
 * Emoticon images, which both exports write as `<img>` against a skin path an
 * import cannot carry. The glyph is the whole content of the element.
 */
const EMOTICONS: Record<string, string> = {
  smile: "🙂",
  sad: "🙁",
  cheeky: "😜",
  laugh: "😄",
  wink: "😉",
  thumbs_up: "👍",
  thumbs_down: "👎",
  information: "ℹ️",
  check: "✅",
  tick: "✅",
  error: "❌",
  warning: "⚠️",
  add: "➕",
  forbidden: "⛔",
  help: "❓",
  lightbulb: "💡",
  lightbulb_on: "💡",
  star_yellow: "⭐",
  star_green: "⭐",
  star_red: "⭐",
  star_blue: "⭐",
  yellow_star: "⭐",
  heart: "❤️",
  broken_heart: "💔",
};

/** The glyph an emoticon image stands for, or null if it is not one. */
export function emoticon(src: string, alt = ""): string | null {
  const match = /emoticons?\/([\w-]+?)(?:_\d+)?\.(?:svg|png|gif)/.exec(src);
  const name = (match?.[1] ?? alt.replace(/:/g, "")).trim().toLowerCase();
  if (!name) return null;
  return EMOTICONS[name] ?? EMOTICONS[name.replace(/-/g, "_")] ?? null;
}

/** A user mention, keyed by email so it resolves once the account exists. */
export function mention(email: string): string {
  const address = email.trim();
  if (!address.includes("@")) return escapeText(`@${address}`);
  const label = address.slice(0, address.indexOf("@"));
  return `<user-mention email="${escapeAttr(address)}">@${escapeText(label)}</user-mention>`;
}

export { escapeAttr, escapeText };
