/**
 * XWiki XAR export -> Vektor space database.
 *
 *   bun run scripts/xar-to-space.ts <export.xar|extracted-dir> [options]
 *
 * Produces a standalone space `.db` (plus an uploads directory for the page
 * attachments) that the server picks up by dropping it into `data/spaces/`.
 *
 * The schema comes from `initSpaceDbSchema`, and the page HTML is round-tripped
 * through `htmlToDoc`/`docToHtml` so the stored content is exactly what the
 * server would have written itself. That second part is not cosmetic: the
 * editor's Yjs sync plugin *deletes* schema-invalid nodes rather than failing,
 * so unnormalized content would silently lose data on first open.
 *
 * `docs/importer.md` governs imports over the CLI, which cannot create a space
 * and so does not apply directly here. Its substance does: every attachment is
 * written and every body rewritten to its upload URL before a single document
 * row is inserted, dates are carried over, and nothing is dropped quietly —
 * anything unresolved is counted and reported at the end.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { unzipSync } from "fflate";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { docToHtml } from "#documents/schema/render.ts";
import { decodeHtmlEntities, escapeHtml } from "#utils/html.ts";
import { slugify } from "#utils/slug.ts";
import {
  assertSlugAvailable,
  newSpaceId,
  pathKey,
  planSpace,
  printSummary,
  Report,
  type SourcePage,
  type SpacePlan,
  transliterate,
  writeSpace,
} from "./lib/space-writer.ts";
import { UploadStore } from "./lib/uploads.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface Options {
  xarPath: string;
  out: string;
  name: string;
  slug: string;
  owner: string;
  uploads: string;
  maxAttachmentBytes: number;
}

function parseOptions(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) flags.set(arg.slice(2), argv[++i] ?? "");
    else positional.push(arg);
  }

  const xarPath = positional[0];
  if (!xarPath) {
    throw new Error(
      "Usage: bun run scripts/xar-to-space.ts <export.xar|extracted-dir> " +
        "[--name <space name>] [--slug <space slug>] [--out <file.db>] " +
        "[--owner <user id>] [--uploads <dir>] [--max-attachment-mb <n>]",
    );
  }

  const fallbackName = xarPath.replace(/^.*\//, "").replace(/\.xar$/i, "");
  const name = flags.get("name") || fallbackName;
  const slug = slugify(flags.get("slug") || transliterate(name));
  if (!slug) throw new Error("Space slug must contain at least one letter or number");

  return {
    xarPath,
    name,
    slug,
    out: flags.get("out") || `./${slug}.db`,
    owner: flags.get("owner") || "local",
    uploads: flags.get("uploads") || "./data/uploads",
    maxAttachmentBytes: Number(flags.get("max-attachment-mb") ?? 100) * 1024 * 1024,
  };
}

// ---------------------------------------------------------------------------
// XAR reading
// ---------------------------------------------------------------------------

function isPageEntry(name: string): boolean {
  // `package.xml` is the manifest, `WebPreferences.xml` holds space rights and
  // objects — neither is a page.
  return (
    name.endsWith(".xml") && name !== "package.xml" && !name.endsWith("WebPreferences.xml")
  );
}

/**
 * Reads page entries one at a time, from a `.xar` or from a directory of
 * entry XMLs extracted from one. Two conference pages in a real export carry a
 * quarter of a gigabyte of base64 attachments each, so the archive is scanned
 * for names first and every entry is inflated on its own — unzipping the whole
 * thing at once would hold every attachment in memory simultaneously.
 *
 * That still reads the whole `.xar` into one buffer, which an export past a few
 * gigabytes cannot be. Extract it first (`unzip`, or Python's `zipfile` where
 * the entry names are not valid UTF-8 and the filesystem refuses them) and pass
 * the directory instead — page identity comes from `<web>`/`<name>` inside each
 * XML, so the extracted filenames do not matter.
 */
function* readPageEntries(source: string): Generator<string> {
  if (statSync(source).isDirectory()) {
    for (const name of readdirSync(source).sort()) {
      if (isPageEntry(name)) yield readFileSync(join(source, name), "utf8");
    }
    return;
  }

  const archive = new Uint8Array(readFileSync(source));
  const names: string[] = [];
  unzipSync(archive, {
    filter: (entry) => {
      if (isPageEntry(entry.name)) names.push(entry.name);
      return false;
    },
  });

  for (const name of names) {
    const [entry] = Object.values(unzipSync(archive, { filter: (e) => e.name === name }));
    if (entry) yield new TextDecoder().decode(entry);
  }
}

// ---------------------------------------------------------------------------
// XWiki XML
// ---------------------------------------------------------------------------

interface Attachment {
  filename: string;
  content: string;
}

interface Page extends SourcePage {
  /** Full XWiki reference, e.g. `Technik.Knowledge base.CORS & CSP.WebHome`. */
  ref: string;
  content: string;
  attachments: Attachment[];
}

function tagValue(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? decodeHtmlEntities(match[1]) : null;
}

function epochDate(value: string | null, fallback: Date): Date {
  const millis = Number(value);
  return Number.isFinite(millis) && millis > 0 ? new Date(millis) : fallback;
}

function parsePage(xml: string): Page | null {
  const web = tagValue(xml, "web");
  const name = tagValue(xml, "name");
  if (!web || !name) return null;

  const attachments: Attachment[] = [];
  for (const match of xml.matchAll(/<attachment>([\s\S]*?)<\/attachment>/g)) {
    const filename = tagValue(match[1], "filename");
    const content = /<content>([\s\S]*?)<\/content>/.exec(match[1])?.[1];
    if (filename && content) attachments.push({ filename, content });
  }

  const createdAt = epochDate(tagValue(xml, "creationDate"), new Date());
  const ref = `${web}.${name}`;
  return {
    ref,
    key: ref,
    path: referencePath(ref),
    // Velocity in a title renders to nothing useful outside XWiki.
    title: (tagValue(xml, "title") ?? "").replace(/\$\{?[\w.()]+\}?/g, "").trim(),
    content: tagValue(xml, "content") ?? "",
    createdAt,
    updatedAt: epochDate(tagValue(xml, "date"), createdAt),
    attachments,
  };
}

/**
 * The nesting path a reference denotes.
 *
 * The tree comes from the reference and not from the `<parent>` field: that
 * field is XWiki's legacy breadcrumb, which in a real export is variously
 * empty, relative (`WebHome`), or pointing outside the exported subtree. A
 * nested page instead *is* its path, with the trailing `WebHome` being the page
 * itself rather than a child.
 *
 * Dots inside a segment are written `\.` and must not split it.
 */
function referencePath(ref: string): string[] {
  const segments = splitReference(ref);
  if (segments.length > 1 && segments.at(-1) === "WebHome") segments.pop();
  return segments;
}

/**
 * Splits an XWiki reference on its unescaped dots and unescapes the rest.
 *
 * The escaping is load-bearing rather than decorative: a mention reads
 * `xwiki:XWiki.p\.reichard@s-v\.de`, so splitting on every dot returns "de"
 * instead of the address.
 */
function splitReference(ref: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < ref.length; i++) {
    if (ref[i] === "\\" && i + 1 < ref.length) {
      current += ref[++i];
    } else if (ref[i] === ".") {
      segments.push(current);
      current = "";
    } else {
      current += ref[i];
    }
  }
  segments.push(current);
  return segments;
}

// ---------------------------------------------------------------------------
// XWiki 2.1 syntax -> HTML
// ---------------------------------------------------------------------------

/**
 * XWiki status badge colours as a foreground/background pair. Fixed on both
 * halves so a badge stays legible whatever the page is sitting on.
 */
const STATUS_COLOURS: Record<string, [string, string]> = {
  green: ["#dcfce7", "#166534"],
  yellow: ["#fef9c3", "#854d0e"],
  red: ["#fee2e2", "#991b1b"],
  blue: ["#dbeafe", "#1e40af"],
  grey: ["#e5e7eb", "#374151"],
};

/** Resolves what a link or image target points at, or null to render as text. */
interface LinkResolver {
  /** Takes a raw target: a bare filename, `attach:name`, or `attach:Page@name`. */
  attachment(target: string): string | null;
  page(ref: string): string | null;
}

const INLINE_MARK = "\u0000";
const LITERAL_MARK = "\u0001";
const BLOCK_MARK = "\u0002";
const WIDTH_MARK = "\u0003";
const TASK_MARK = "\u0004";

const IS_BLOCK_HOLD = new RegExp(`^${BLOCK_MARK}\\d+${BLOCK_MARK}$`);

/**
 * Finished HTML parked behind a placeholder so the remaining text passes cannot
 * reinterpret it.
 *
 * Inline and block holds are distinguished because the document schema has no
 * inline image and no inline code block: one left inside a `<p>` is dropped
 * outright on parse, so a block hold has to be lifted to sibling position.
 */
class Held {
  private readonly inlines: string[] = [];
  private readonly blocks: string[] = [];
  private readonly literals: string[] = [];

  /** Holds HTML that belongs inside a paragraph, such as a link. */
  inline(html: string): string {
    return `${INLINE_MARK}${this.inlines.push(html) - 1}${INLINE_MARK}`;
  }

  /** Holds HTML that must end up as a block of its own. */
  block(html: string): string {
    return `${BLOCK_MARK}${this.blocks.push(html) - 1}${BLOCK_MARK}`;
  }

  /** Holds a `~`-escaped character so it cannot trigger any later syntax. */
  literal(char: string): string {
    return `${LITERAL_MARK}${this.literals.push(char) - 1}${LITERAL_MARK}`;
  }

  restore(html: string): string {
    return html
      .replace(
        new RegExp(`${INLINE_MARK}(\\d+)${INLINE_MARK}`, "g"),
        (_, i) => this.inlines[i],
      )
      .replace(
        new RegExp(`${BLOCK_MARK}(\\d+)${BLOCK_MARK}`, "g"),
        (_, i) => this.blocks[i],
      )
      .replace(new RegExp(`${LITERAL_MARK}(\\d+)${LITERAL_MARK}`, "g"), (_, i) =>
        escapeHtml(this.literals[i]),
      );
  }
}

/**
 * Splits a run of inline HTML into the paragraphs, and the block holds (images,
 * code) that sat between them. Empty in, empty out.
 */
function blocksFromInline(html: string): string {
  return html
    .split(new RegExp(`(${BLOCK_MARK}\\d+${BLOCK_MARK})`))
    .filter((part) => part && part !== "<br>")
    .map((part) => (IS_BLOCK_HOLD.test(part) ? part : paragraphs(part)))
    .join("");
}

/**
 * Wraps inline HTML in a paragraph, lifting any `{{task}}` in it into a task
 * list of its own. A task inside a table cell arrives here rather than at the
 * block reader, and the schema has no inline task item — left where it is, its
 * marker would stay in the text as a control character.
 */
function paragraphs(html: string): string {
  if (!html.includes(TASK_MARK)) return `<p>${html}</p>`;

  const out: string[] = [];
  let tasks: string[] = [];
  const flush = () => {
    if (tasks.length) out.push(`<ul data-type="taskList">${tasks.join("")}</ul>`);
    tasks = [];
  };

  for (const segment of html.split("<br>")) {
    // `[text, status, body, status, body, …]`, one pair per task in the line.
    const parts = segment.split(new RegExp(`${TASK_MARK}([01])${TASK_MARK}`));
    const text = parts[0].trim();
    if (text) {
      flush();
      out.push(`<p>${text}</p>`);
    }
    for (let index = 1; index < parts.length; index += 2) {
      const done = parts[index] === "1";
      tasks.push(
        `<li data-type="taskItem" data-checked="${done}">` +
          `<p>${parts[index + 1].trim()}</p></li>`,
      );
    }
  }

  flush();
  return out.join("");
}

function xwikiToHtml(source: string, links: LinkResolver, report: Report): string {
  const held = new Held();
  let text = source.replace(/\r\n?/g, "\n");

  // Literal bodies first, before anything can interpret their contents.
  text = text.replace(/\{\{\{([\s\S]*?)\}\}\}/g, (_, body) =>
    held.block(`<pre><code>${escapeHtml(body)}</code></pre>`),
  );
  text = text.replace(
    /\{\{code([^}]*)\}\}([\s\S]*?)\{\{\/code\}\}/g,
    (_, params, body) => {
      const language = /language\s*=\s*"([^"]*)"/.exec(params)?.[1];
      const attrs = language ? ` class="language-${escapeHtml(language)}"` : "";
      return held.block(
        `<pre><code${attrs}>${escapeHtml(String(body).trim())}</code></pre>`,
      );
    },
  );
  text = text.replace(/\{\{html[^}]*\}\}([\s\S]*?)\{\{\/html\}\}/g, (_, body) =>
    held.block(String(body)),
  );

  // Server-side macros render to nothing without XWiki behind them.
  text = text.replace(
    /\{\{(velocity|groovy|python|toc|children|include)[^}]*\}\}[\s\S]*?\{\{\/\1\}\}/g,
    (_, name: string) => {
      report.drop(name);
      return "";
    },
  );
  // Two self-closing macros carry content of their own and are rebuilt rather
  // than dropped: mentions record who owns a page or topic, and status badges
  // carry the date and state that make a meeting table readable.
  text = text.replace(
    /\{\{mention[^}]*reference="([^"]*)"[^}]*\/\}\}/g,
    (_, reference: string) => held.inline(mention(reference)),
  );
  // Two badges written back to back merge into one pill when they share a
  // colour — equal marks coalesce — so "Frontend" and "BACKEND" come out as a
  // single "FrontendBACKEND". A space between them keeps them apart.
  text = text.replace(/(\{\{status[^}]*\/\}\})(?=\{\{status)/g, "$1 ");
  text = text.replace(/\{\{status([^}]*)\/\}\}/g, (_, params: string) =>
    held.inline(status(params)),
  );
  // `view-file` embeds an attachment that this import has already uploaded, and
  // `embed` is almost always a video. Dropping either left a page referring to
  // material that is present but unreachable.
  text = text.replace(/\{\{view-file([^}]*)\/\}\}/g, (_, params: string) => {
    const filename = /att--filename="([^"]*)"/.exec(params)?.[1];
    const src = filename ? links.attachment(filename) : null;
    if (!src) {
      report.drop("view-file");
      return "";
    }
    return held.block(
      `<file-attachment src="${escapeHtml(src)}" filename="${escapeHtml(filename ?? "file")}"></file-attachment>`,
    );
  });
  text = text.replace(/\{\{embed([^}]*)\/\}\}/g, (_, params: string) => {
    const url = /url="([^"]*)"/.exec(params)?.[1];
    if (!url) {
      report.drop("embed");
      return "";
    }
    return held.inline(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
  });
  // A task is a checklist item, so it becomes one rather than a loose
  // paragraph. Its body is folded onto a single line for the block reader.
  text = text.replace(
    /\{\{task([^}]*)\}\}([\s\S]*?)\{\{\/task\}\}/g,
    (_, params: string, body: string) => {
      const done = /status="(Done|Completed)"/i.test(params);
      return `\n${TASK_MARK}${done ? "1" : "0"}${TASK_MARK}${body.trim().replace(/\s*\n+\s*/g, " ")}\n`;
    },
  );
  // An iframe's whole content is its URL, so dropping the macro dropped all of it.
  text = text.replace(
    /\{\{iframe([^}]*)\}\}[\s\S]*?\{\{\/iframe\}\}/g,
    (_, params: string) => {
      const url = /url="([^"]*)"/.exec(params)?.[1];
      if (!url) {
        report.drop("iframe");
        return "";
      }
      const name = /name="([^"]*)"/.exec(params)?.[1] || url;
      return held.inline(`<a href="${escapeHtml(url)}">${escapeHtml(name)}</a>`);
    },
  );
  // `{{date value="2023-10-30"/}}` is a literal date; the macro was the only
  // thing holding it.
  text = text.replace(/\{\{date([^}]*)\/\}\}/g, (_, params: string) => {
    const value = /value="([^"]*)"/.exec(params)?.[1];
    if (!value) {
      report.drop("date");
      return "";
    }
    return escapeHtml(value);
  });
  text = text.replace(/\{\{([\w-]+)[^}]*\/\}\}/g, (_, name: string) => {
    report.drop(name);
    return "";
  });
  // Container macros (info, box, the Confluence layout grid, …) keep their body
  // and lose their frame. A title is the one part of the frame that is content
  // rather than styling, so it survives as a bold line.
  text = text.replace(
    /\{\{(\/?)([\w-]+)([^}]*)\}\}/g,
    (_, closing: string, name: string, params: string) => {
      if (closing) return "";
      report.flatten(name);
      const title = /title="([^"]*)"/.exec(params)?.[1];
      return title ? `**${title}**\n` : "";
    },
  );

  text = text.replace(/~([\s\S])/g, (_, char) => held.literal(char));
  // Rows are rejoined before widths are read, so a cell that opens on one line
  // and closes on the next is a single row by the time it is measured.
  text = joinTableRows(text);
  text = extractCellWidths(text);
  // Styling parameters: `(% style="…" %)` before a block, `(%%)` to reset.
  text = text.replace(/\(%.*?%\)/gs, "");
  // Group delimiters wrap a block and render as nothing. They are not always on
  // a line of their own — a table cell holding a multi-line group opens with
  // `|(((` and the next row closes with `)))|` — so they go globally. Safe
  // here because verbatim and code bodies were held out above.
  text = text.replace(/\(\(\(|\)\)\)/g, "");
  text = text.replace(/\[\[([\s\S]+?)\]\]/g, (_, inner) => link(inner, links, held));
  text = text.replace(/(^|\s)image:(\S+)/g, (match, lead, name) => {
    const src = imageSource(name, links);
    return src ? `${lead}${held.block(image(src, ""))}` : match;
  });

  return held.restore(renderBlocks(text.split("\n")));
}

/** A checklist item, as `{{task}}` was rewritten by `xwikiToHtml`. */
const TASK_LINE = new RegExp(`^${TASK_MARK}([01])${TASK_MARK}(.*)$`);

/** A table row, allowing for the row-level parameter group that may precede it. */
const TABLE_ROW = /^(?:\(%[^)]*%\))?\|/;

/**
 * Moves each cell's width out of its styling parameters and in front of the
 * cell, where `renderTable` turns it into `colwidth`. Left alone, every column
 * lands on the same default width and a wide table reads wrongly.
 *
 * Per line, and only for real rows: a paragraph is allowed to contain a pipe
 * ("CMS Systeme, die wir einsetzen|…"), and treating one as a cell would leave
 * the marker sitting in prose.
 */
function extractCellWidths(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      TABLE_ROW.test(line)
        ? line.replace(/\|(=?)\(%([^)]*)%\)/g, (_, header: string, params: string) => {
            const width = /width\s*:\s*(\d+)/.exec(params)?.[1];
            return `|${header}${width ? `${WIDTH_MARK}${width}${WIDTH_MARK}` : ""}`;
          })
        : line,
    )
    .join("\n");
}

function groupDepth(line: string): number {
  return (line.match(/\(\(\(/g) ?? []).length - (line.match(/\)\)\)/g) ?? []).length;
}

/** Something that begins a block of its own, so it cannot be a cell's next line. */
const BLOCK_START = /^(?:={1,6}\s|-{4,}$|\*+\s|1+\.\s|[;:>]|\(\(\(|\)\)\))/;

/** Whether a line continues the cell above rather than starting something new. */
function isCellContinuation(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (TABLE_ROW.test(line) || BLOCK_START.test(trimmed)) return false;
  if (IS_BLOCK_HOLD.test(trimmed) || trimmed.startsWith(TASK_MARK)) return false;
  return true;
}

/**
 * Rejoins a table row whose cell spans several lines. The block reader is
 * one-row-per-line, so left alone such a table comes apart into a table, a
 * stray paragraph, and another table.
 *
 * Cells run across lines two ways. Usually as a group, which puts the row's
 * opening `|(((`, the text, and the closing `)))|next cell` on three separate
 * lines — 87 of the 284 pages in a real export do this. Occasionally the lines
 * simply run on with no group at all and the next cell opens mid-line ("…für
 * Entwickler interessant|@tohac"); rarer, but it breaks a table just as
 * thoroughly.
 */
function joinTableRows(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!TABLE_ROW.test(line)) {
      out.push(line);
      continue;
    }

    const body: string[] = [];
    let depth = groupDepth(line);
    let tail = "";

    while (depth > 0 && index + 1 < lines.length) {
      const next = lines[++index];
      depth += groupDepth(next);
      if (depth > 0) {
        const content = next.replace(/\(\(\(|\)\)\)/g, "").trim();
        if (content) body.push(content);
        continue;
      }
      // The closing line: whatever precedes `)))` is still part of the cell,
      // and whatever follows it is the rest of the row.
      const [last, ...rest] = next.split(")))");
      if (last.trim()) body.push(last.trim());
      tail = rest.join(")))");
    }

    // `\\` is the wiki's own hard break, so the cell keeps its line structure.
    let row = line.replace(/\(\(\(/g, "") + body.join("\\\\") + tail;
    while (index + 1 < lines.length && isCellContinuation(lines[index + 1])) {
      row += `\\\\${lines[++index].trim()}`;
    }
    out.push(row);
  }

  return out.join("\n");
}

function link(inner: string, links: LinkResolver, held: Held): string {
  const [reference] = inner.split("||");
  const separator = reference.indexOf(">>");
  const label = separator >= 0 ? reference.slice(0, separator).trim() : "";
  const target = (separator >= 0 ? reference.slice(separator + 2) : reference).trim();

  if (target.startsWith("image:")) {
    const src = imageSource(target.slice("image:".length), links);
    return src ? held.block(image(src, label)) : escapeHtml(label);
  }

  const href = hrefFor(target, links);
  const text = escapeHtml(label || target.replace(/^\w+:/, ""));
  return held.inline(href ? `<a href="${escapeHtml(href)}">${text}</a>` : text);
}

/**
 * An XWiki user reference as a mention node. The schema keys a mention on an
 * email, which most references here are; the rest are bare login names with no
 * address to attach, so those stay as plain text.
 */
/**
 * A status badge. XWiki renders these as a coloured pill and this wiki leans on
 * them heavily — a meeting table is mostly dates and states — so dropping them
 * with the other macros took the meaning of the table with it.
 */
function status(params: string): string {
  const title = /title="([^"]*)"/.exec(params)?.[1] ?? "";
  const colour = (/colour="([^"]*)"/.exec(params)?.[1] ?? "grey").toLowerCase();
  const [background, foreground] = STATUS_COLOURS[colour] ?? STATUS_COLOURS.grey;
  const label = escapeHtml(title || colour);
  return `<span style="background-color: ${background}; color: ${foreground}">${label}</span>`;
}

function mention(reference: string): string {
  const user = splitReference(reference).at(-1) ?? "";
  if (!user.includes("@")) return escapeHtml(`@${user}`);
  const label = user.slice(0, user.indexOf("@"));
  return `<user-mention email="${escapeHtml(user)}">@${escapeHtml(label)}</user-mention>`;
}

function image(src: string, alt: string): string {
  return `<img src="${escapeHtml(src)}"${alt ? ` alt="${escapeHtml(alt)}"` : ""}>`;
}

/** An image is either an attachment (usually written `image:attach:…`) or a URL. */
function imageSource(target: string, links: LinkResolver): string | null {
  if (target.startsWith("url:")) return target.slice("url:".length);
  if (/^https?:\/\//.test(target)) return target;
  return links.attachment(target);
}

function hrefFor(target: string, links: LinkResolver): string | null {
  if (target.startsWith("attach:")) return links.attachment(target);
  if (target.startsWith("mailto:") || /^https?:\/\//.test(target)) return target;
  if (target.startsWith("url:")) return target.slice("url:".length);
  if (target.startsWith("#")) return null;
  return links.page(target.replace(/^doc:/, ""));
}

interface ListItem {
  depth: number;
  ordered: boolean;
  html: string;
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let list: ListItem[] = [];
  let rows: string[][] = [];
  let quote: string[] = [];
  let tasks: { done: boolean; html: string }[] = [];

  const flush = () => {
    if (paragraph.length) {
      out.push(blocksFromInline(paragraph.join("<br>")));
      paragraph = [];
    }
    if (list.length) {
      out.push(renderList(list));
      list = [];
    }
    if (rows.length) {
      out.push(renderTable(rows));
      rows = [];
    }
    if (quote.length) {
      out.push(
        `<blockquote>${blocksFromInline(quote.join("<br>")) || "<p></p>"}</blockquote>`,
      );
      quote = [];
    }
    if (tasks.length) {
      const items = tasks
        .map(
          (task) =>
            `<li data-type="taskItem" data-checked="${task.done}">` +
            `${blocksFromInline(task.html) || "<p></p>"}</li>`,
        )
        .join("");
      out.push(`<ul data-type="taskList">${items}</ul>`);
      tasks = [];
    }
  };

  for (const line of lines) {
    const bare = line.trim();
    // A group is a block wrapper with no rendering of its own, and it does not
    // have to sit on its own line — `((([[Label>>url]])))` is one line.
    const trimmed = bare.replace(/^(?:\(\(\()+\s*/, "").replace(/\s*(?:\)\)\))+$/, "");

    if (!trimmed) {
      // Delimiters alone on a line wrap the block around them; they are not the
      // blank line that would end a paragraph.
      if (!bare) flush();
      continue;
    }

    const heading = /^(={1,6})\s*(.*?)\s*\1$/.exec(trimmed);
    if (heading) {
      flush();
      const level = heading[1].length;
      const [text, ...blocks] = splitBlockHolds(inline(heading[2]));
      out.push(`<h${level}>${text}</h${level}>`, ...blocks);
      continue;
    }

    if (/^-{4,}$/.test(trimmed)) {
      flush();
      out.push("<hr>");
      continue;
    }

    const item = /^([*]+|1+\.)\s+(.*)$/.exec(trimmed);
    if (item) {
      if (paragraph.length || rows.length || quote.length) flush();
      const ordered = item[1].endsWith(".");
      list.push({
        depth: ordered ? item[1].length - 1 : item[1].length,
        ordered,
        html: inline(item[2]),
      });
      continue;
    }

    if (trimmed.startsWith("|")) {
      if (paragraph.length || list.length || quote.length) flush();
      rows.push(trimmed.slice(1).split("|"));
      continue;
    }

    const task = TASK_LINE.exec(trimmed);
    if (task) {
      if (paragraph.length || list.length || rows.length || quote.length) flush();
      tasks.push({ done: task[1] === "1", html: inline(task[2]) });
      continue;
    }

    const quoted = /^>+\s?(.*)$/.exec(trimmed);
    if (quoted) {
      if (paragraph.length || list.length || rows.length) flush();
      quote.push(inline(quoted[1]));
      continue;
    }

    // Definition lists have no schema node; the term reads fine emphasised.
    const term = /^;\s*(.*)$/.exec(trimmed);
    if (term) {
      flush();
      out.push(`<p><strong>${inline(term[1])}</strong></p>`);
      continue;
    }
    const definition = /^:\s*(.*)$/.exec(trimmed);
    if (definition) {
      flush();
      out.push(`<p>${inline(definition[1])}</p>`);
      continue;
    }

    if (IS_BLOCK_HOLD.test(trimmed)) {
      flush();
      out.push(trimmed);
      continue;
    }

    if (list.length || rows.length || quote.length || tasks.length) flush();
    paragraph.push(inline(trimmed));
  }

  flush();
  return out.join("\n");
}

/** Inline HTML with its block holds removed, followed by those holds. */
function splitBlockHolds(html: string): string[] {
  const holds: string[] = [];
  const text = html.replace(new RegExp(`${BLOCK_MARK}\\d+${BLOCK_MARK}`, "g"), (hold) => {
    holds.push(hold);
    return "";
  });
  return [text, ...holds];
}

function renderList(items: ListItem[]): string {
  const open: boolean[] = [];
  let html = "";
  const close = () => (html += `</li>${open.pop() ? "</ol>" : "</ul>"}`);

  for (const item of items) {
    while (open.length > item.depth) close();
    if (open.length === item.depth) {
      html += "</li>";
      if (open[open.length - 1] !== item.ordered) {
        html += open.pop() ? "</ol>" : "</ul>";
        html += item.ordered ? "<ol>" : "<ul>";
        open.push(item.ordered);
      }
    }
    while (open.length < item.depth) {
      html += item.ordered ? "<ol>" : "<ul>";
      open.push(item.ordered);
    }
    html += `<li>${blocksFromInline(item.html) || "<p></p>"}`;
  }

  while (open.length) close();
  return html;
}

const CELL_WIDTH = new RegExp(`^${WIDTH_MARK}(\\d+)${WIDTH_MARK}`);

function renderTable(rows: string[][]): string {
  const body = rows
    .map((cells) => {
      const html = cells
        .map((cell) => {
          const header = cell.startsWith("=");
          const tag = header ? "th" : "td";
          const rest = header ? cell.slice(1) : cell;
          const width = CELL_WIDTH.exec(rest);
          const attrs = width ? ` colwidth="${width[1]}"` : "";
          const content = blocksFromInline(
            inline(width ? rest.slice(width[0].length) : rest),
          );
          return `<${tag}${attrs}>${content || "<p></p>"}</${tag}>`;
        })
        .join("");
      return `<tr>${html}</tr>`;
    })
    .join("");
  return `<table><tbody>${body}</tbody></table>`;
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\/\/(.+?)\/\//g, "<em>$1</em>")
    .replace(/__(.+?)__/g, "<u>$1</u>")
    .replace(/--(.+?)--/g, "<s>$1</s>")
    .replace(/##(.+?)##/g, "<code>$1</code>")
    .replace(/\^\^(.+?)\^\^/g, "<sup>$1</sup>")
    .replace(/,,(.+?),,/g, "<sub>$1</sub>")
    .replace(/\\\\/g, "<br>");
}

/**
 * Wiki syntax that should have been consumed. Only a hint, not proof: a page
 * documenting XWiki quotes `{{task}}` as prose, and that is not a defect.
 */
const RESIDUE: [RegExp, string][] = [
  [/\{\{\/?[a-zA-Z]/, "macro"],
  [/\(\(\(|\)\)\)/, "group delimiter"],
  [/\[\[[^\]]*>>/, "link"],
  [/(^|[\s>])(image|attach):\S/, "asset reference"],
  [/\(%[^)]*%\)/, "parameter group"],
];

/** Built from the marks rather than written out, so the two cannot drift. */
const UNRESTORED_HOLD = new RegExp(
  `[${INLINE_MARK}${LITERAL_MARK}${BLOCK_MARK}${WIDTH_MARK}${TASK_MARK}]`,
);

/**
 * A leftover placeholder is an invisible control character in someone's
 * document and can only be a converter bug, so it stops the run. Wiki-looking
 * text only gets counted — see `RESIDUE`.
 */
function checkConverted(html: string, slug: string, report: Report): void {
  const leftover = UNRESTORED_HOLD.exec(html);
  if (leftover) {
    const at = leftover.index;
    const context = html.slice(Math.max(0, at - 160), at + 160);
    throw new Error(`Unrestored placeholder in "${slug}": ${JSON.stringify(context)}`);
  }
  for (const [pattern, what] of RESIDUE) {
    if (pattern.test(html)) report.residue.push(`${slug}: possible XWiki ${what}`);
  }
}
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const report = new Report();
  // Writing into an existing database would append a second space's worth of
  // rows to it rather than replace them.
  const out = resolve(options.out);
  if (existsSync(out)) throw new Error(`Output database already exists: ${out}`);
  assertSlugAvailable(options.slug);

  console.log(`Reading ${options.xarPath}`);

  // Pass 1: pages and attachments. Attachment bodies are written straight to
  // disk so the base64 never accumulates across pages.
  const pages: Page[] = [];
  const spaceId = newSpaceId();
  const uploadsRoot = join(resolve(options.uploads), spaceId);
  const uploads = new UploadStore(uploadsRoot, spaceId, options.maxAttachmentBytes);
  const attachmentUrls = new Map<string, Map<string, string>>();
  /** Fallback for `attach:Other Page@file.png`, which names another page's file. */
  const attachmentsByName = new Map<string, string>();

  for (const xml of readPageEntries(options.xarPath)) {
    const page = parsePage(xml);
    if (!page) continue;

    const forPage = new Map<string, string>();
    for (const attachment of page.attachments) {
      const url = uploads.add(
        Buffer.from(attachment.content, "base64"),
        attachment.filename,
      );
      if (!url) continue;
      forPage.set(attachment.filename, url);
      if (!attachmentsByName.has(attachment.filename)) {
        attachmentsByName.set(attachment.filename, url);
      }
    }
    page.attachments = [];
    attachmentUrls.set(page.ref, forPage);
    pages.push(page);
  }

  console.log(`Parsed ${pages.length} pages, ${uploads.size} attachments`);

  // Pass 2: identity and hierarchy, resolved before any content is converted so
  // that cross-page links can point at their target's final slug.
  const plan: SpacePlan<Page> = planSpace(pages, options.slug, report, spaceId);

  // Bodies are converted before anything is written: whether a section page is
  // worth keeping depends on what it converts to, and that decides both the tree
  // the documents are stored with and where the categories are pinned.
  const bodies = new Map<string, string>();
  for (const { id, slug, page } of plan.byPath.values()) {
    const attachments = attachmentUrls.get(page.ref) ?? new Map<string, string>();
    const resolver: LinkResolver = {
      attachment: (target) => {
        // `attach:Other Page@file.png` names a file hanging off another page.
        const name = (
          target
            .replace(/^attach:/, "")
            .split("@")
            .pop() ?? ""
        ).trim();
        const url = attachments.get(name) ?? attachmentsByName.get(name);
        if (!url) report.unresolvedAttachments.add(name);
        return url ?? null;
      },
      page: (ref) => {
        const path = referencePath(ref);
        // A leading empty segment (`.Some Page.WebHome`) means "this wiki".
        if (path[0] === "") path.shift();
        if (path.length === 0) return null;

        const target =
          plan.byPath.get(pathKey(path)) ??
          plan.byPath.get(pathKey([...page.path, ...path])) ??
          plan.bySuffix.get(pathKey(path.slice(1)));
        if (!target) report.unresolvedPages.add(ref);
        return target ? plan.docPath(target.slug) : null;
      },
    };

    const body = docToHtml(htmlToDoc(xwikiToHtml(page.content, resolver, report)));
    checkConverted(body, slug, report);
    bodies.set(id, body);
  }

  const write = { out, name: options.name, owner: options.owner };
  const result = await writeSpace(plan, bodies, uploads, write, report);
  printSummary(plan, result, uploads, { ...write, uploadsRoot }, report);
  if (uploadsRoot !== join(resolve("./data/uploads"), plan.spaceId)) {
    console.log(`  mv ${uploadsRoot} data/uploads/${plan.spaceId}`);
  }
}

await main();
