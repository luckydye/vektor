/**
 * Confluence HTML space export -> Vektor space database.
 *
 *   bun run scripts/confluence-html-to-space.ts <export-dir> [options]
 *
 * The input is what "Export space > HTML" produces: one rendered `.html` per
 * page, an `index.html` holding the page tree, and `attachments/<pageId>/` with
 * every file named by its attachment id. That is a different export than
 * `confluence-export-to-staging.py` reads — an XML space export carries the
 * storage-format source and the full revision history, and should be preferred
 * when it can be obtained. An HTML export has only the current rendering of each
 * page, so this importer creates one revision per document and takes the single
 * date the export prints as both created and modified.
 *
 * What it does preserve: the page tree, titles, every attachment, the authorship
 * date, inline tasks, status badges, code panels, column layouts, info panels,
 * user mentions (the export leaks the address in `/display/~email` links), page
 * links repointed at their new slugs, and page comments appended to the body.
 *
 * `docs/importer.md` governs imports over the CLI, which cannot create a space
 * and so does not apply directly here. Its substance does: every attachment is
 * uploaded and every body rewritten to its upload URL before a single document
 * row is inserted, and nothing is dropped quietly.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { docToHtml } from "#documents/schema/render.ts";
import { type HtmlNode, type HtmlTagNode, parseHtml, SyntaxKind } from "#utils/html.ts";
import { slugify } from "#utils/slug.ts";
import {
  cleanHtml,
  decodeEntities,
  type Element,
  emoticon,
  escapeAttr,
  escapeText,
  lozenge,
  mention,
  type Rule,
  unknownEntities,
} from "./lib/html-clean.ts";
import {
  assertSlugAvailable,
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
  exportDir: string;
  out: string;
  name: string;
  slug: string;
  owner: string;
  uploads: string;
  maxAttachmentBytes: number;
  /** Origin unresolvable page and profile links are repointed at. */
  confluenceUrl: string;
  limit: number;
  /** Drop the export's wrapper page even when it carries text of its own. */
  dropRoot: boolean;
  comments: boolean;
}

function parseOptions(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--no-")) flags.set(arg.slice(2), "");
    else if (arg.startsWith("--")) flags.set(arg.slice(2), argv[++i] ?? "");
    else positional.push(arg);
  }

  const exportDir = positional[0];
  if (!exportDir) {
    throw new Error(
      "Usage: bun run scripts/confluence-html-to-space.ts <export-dir> " +
        "[--name <space name>] [--slug <space slug>] [--out <file.db>] " +
        "[--owner <user id>] [--uploads <dir>] [--max-attachment-mb <n>] " +
        "[--confluence-url <origin>] [--limit <n>] [--no-comments] [--drop-root]",
    );
  }

  return {
    exportDir: resolve(exportDir),
    name: flags.get("name") ?? "",
    slug: flags.get("slug") ?? "",
    out: flags.get("out") ?? "",
    owner: flags.get("owner") || "local",
    uploads: resolve(flags.get("uploads") || "./data/uploads"),
    maxAttachmentBytes: Number(flags.get("max-attachment-mb") ?? 100) * 1024 * 1024,
    confluenceUrl: (flags.get("confluence-url") ?? "").replace(/\/+$/, ""),
    limit: Number(flags.get("limit") ?? 0),
    dropRoot: flags.has("drop-root"),
    comments: !flags.has("no-comments"),
  };
}

// ---------------------------------------------------------------------------
// Reading the export
// ---------------------------------------------------------------------------

interface Attachment {
  /** Path as content links write it, e.g. `attachments/204409606/204409608.pdf`. */
  href: string;
  filename: string;
}

interface Comment {
  author: string;
  posted: string;
  body: HtmlNode[];
}

interface Page extends SourcePage {
  /** Export file name, which is how other pages link to it. */
  file: string;
  id: string;
  body: HtmlNode[];
  attachments: Attachment[];
  comments: Comment[];
}

function findTag(
  nodes: HtmlNode[],
  match: (tag: HtmlTagNode) => boolean,
): HtmlTagNode | null {
  for (const node of nodes) {
    if (node.type !== SyntaxKind.Tag) continue;
    const tag = node as HtmlTagNode;
    if (match(tag)) return tag;
    const found = findTag(tag.body ?? [], match);
    if (found) return found;
  }
  return null;
}

function findTags(
  nodes: HtmlNode[],
  match: (tag: HtmlTagNode) => boolean,
  out: HtmlTagNode[] = [],
): HtmlTagNode[] {
  for (const node of nodes) {
    if (node.type !== SyntaxKind.Tag) continue;
    const tag = node as HtmlTagNode;
    if (match(tag)) out.push(tag);
    findTags(tag.body ?? [], match, out);
  }
  return out;
}

function attr(tag: HtmlTagNode, name: string): string | null {
  const found = tag.attributes?.find((entry) => entry.name.value.toLowerCase() === name);
  return found ? decodeEntities(found.value?.value ?? "") : null;
}

function hasClass(tag: HtmlTagNode, name: string): boolean {
  return (attr(tag, "class") ?? "").split(/\s+/).includes(name);
}

function textOf(nodes: HtmlNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === SyntaxKind.Text) return decodeEntities(node.value);
      const tag = node as HtmlTagNode;
      return tag.name.toLowerCase() === "br" ? " " : textOf(tag.body ?? []);
    })
    .join("");
}

const byId = (name: string) => (tag: HtmlTagNode) => attr(tag, "id") === name;

/**
 * `Jan 19, 2024` — the only date an HTML export prints, and only to the day.
 * There is no second date to distinguish creation from modification, so a page
 * gets this one for both.
 */
function parseDate(value: string): Date | null {
  const match = /([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{4})/.exec(value);
  if (!match) return null;
  const months = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
  const month = months.indexOf(match[1] as string);
  if (month < 0) return null;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[2]), 12));
}

interface SpaceDetails {
  key: string;
  name: string;
  /** Export file name -> its children, in export order. */
  tree: Map<string, string[]>;
  roots: string[];
  titles: Map<string, string>;
}

/**
 * The page tree, taken from `index.html` rather than from each page's
 * breadcrumb: only the index gives sibling order, and it is the one place that
 * lists every exported page.
 */
function readIndex(dir: string): SpaceDetails {
  const html = readFileSync(join(dir, "index.html"), "utf8");
  const root = parseHtml(html);

  const details = new Map<string, string>();
  for (const row of findTags(root, (tag) => tag.name.toLowerCase() === "tr")) {
    const cells = (row.body ?? []).filter(
      (node) => node.type === SyntaxKind.Tag,
    ) as HtmlTagNode[];
    if (cells.length === 2) {
      details.set(
        textOf(cells[0]?.body ?? []).trim(),
        textOf(cells[1]?.body ?? []).trim(),
      );
    }
  }

  const tree = new Map<string, string[]>();
  const titles = new Map<string, string>();
  const roots: string[] = [];

  /** Collects a `<ul>` of pages, each `<li>` optionally holding nested lists. */
  const walk = (list: HtmlTagNode, into: string[]): void => {
    for (const node of list.body ?? []) {
      if (node.type !== SyntaxKind.Tag) continue;
      const item = node as HtmlTagNode;
      if (item.name.toLowerCase() !== "li") continue;

      const link = findTag(item.body ?? [], (tag) => tag.name.toLowerCase() === "a");
      const href = link ? attr(link, "href") : null;
      if (!link || !href) continue;

      const file = decodeURIComponent(href);
      titles.set(file, textOf(link.body ?? []).trim());
      into.push(file);

      const children: string[] = [];
      // Sibling pages are sometimes emitted as several `<ul>`s inside one `<li>`
      // rather than one list, so every nested list of this item is collected.
      for (const child of item.body ?? []) {
        if (
          child.type === SyntaxKind.Tag &&
          (child as HtmlTagNode).name.toLowerCase() === "ul"
        ) {
          walk(child as HtmlTagNode, children);
        }
      }
      tree.set(file, children);
    }
  };

  // The first list under "Available Pages:" is the tree; the details table above
  // it holds no lists, so the first `<ul>` in the document is the right one.
  const list = findTag(root, (tag) => tag.name.toLowerCase() === "ul");
  if (!list) throw new Error("index.html holds no page list");
  walk(list, roots);

  const name = details.get("Name") ?? "";
  const key = details.get("Key") ?? "";
  if (!name || !key) throw new Error("index.html holds no space name or key");
  return { key, name, tree, roots, titles };
}

/** Reads one exported page. Anything structural that is missing is an error. */
function readPage(dir: string, file: string, spaceName: string): Page {
  const html = readFileSync(join(dir, file), "utf8");
  const root = parseHtml(html);

  const titleTag = findTag(root, byId("title-text"));
  if (!titleTag) throw new Error(`${file}: no #title-text`);
  // The export prefixes every title with the space name.
  const title = textOf(titleTag.body ?? [])
    .trim()
    .replace(
      new RegExp(`^${spaceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*`),
      "",
    )
    .trim();

  const main = findTag(root, byId("main-content"));
  if (!main) throw new Error(`${file}: no #main-content`);

  const metadata = findTag(root, (tag) => hasClass(tag, "page-metadata"));
  const stamp = metadata ? parseDate(textOf(metadata.body ?? [])) : null;
  if (!stamp) throw new Error(`${file}: no readable date in .page-metadata`);

  const attachments: Attachment[] = [];
  const comments: Comment[] = [];
  for (const section of findTags(root, (tag) => hasClass(tag, "pageSection"))) {
    const header = findTag(section.body ?? [], (tag) =>
      hasClass(tag, "pageSectionTitle"),
    );
    const kind = header ? textOf(header.body ?? []).trim() : "";
    if (kind === "Attachments:") {
      for (const link of findTags(
        section.body ?? [],
        (tag) => tag.name.toLowerCase() === "a",
      )) {
        const href = attr(link, "href");
        if (href?.startsWith("attachments/")) {
          attachments.push({ href, filename: textOf(link.body ?? []).trim() });
        }
      }
    }
    if (kind === "Comments:") {
      // One `<tr>` per comment, holding the body in a `<font>` and the byline in
      // the `div.smallfont` that follows it.
      for (const row of findTags(
        section.body ?? [],
        (tag) => tag.name.toLowerCase() === "tr",
      )) {
        const body = findTag(row.body ?? [], (tag) => tag.name.toLowerCase() === "font");
        if (!body) continue;
        const byline = findTags(row.body ?? [], (tag) => hasClass(tag, "smallfont"))
          .map((tag) => textOf(tag.body ?? []).trim())
          .find((text) => text.startsWith("Posted by"));
        const match = /Posted by (\S+) at (.+)$/.exec(byline ?? "");
        comments.push({
          author: match?.[1] ?? "",
          posted: match?.[2]?.trim() ?? "",
          body: body.body ?? [],
        });
      }
    }
  }

  const id = /_?(\d+)\.html$/.exec(file)?.[1];
  if (!id) throw new Error(`${file}: no page id in the file name`);

  return {
    key: file,
    file,
    id,
    path: [],
    title: title || file,
    createdAt: stamp,
    updatedAt: stamp,
    body: main.body ?? [],
    attachments,
    comments,
  };
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

/** Everything a body needs to rewrite its links. */
interface Links {
  /** Local attachment path -> upload URL. */
  attachment(href: string): string | null;
  /** Export file name -> document path. */
  page(href: string): string | null;
  /** Base64 image data -> upload URL. */
  inlineImage(data: string): string | null;
}

const COLUMN_COUNTS: Record<string, number> = {
  single: 1,
  "two-equal": 2,
  "two-left-sidebar": 2,
  "two-right-sidebar": 2,
  "three-equal": 3,
  "three-with-sidebars": 3,
};

/**
 * Live-query macros: they render a list of pages, a table of contents or a
 * contributor list from the wiki at view time and have no static equivalent, so
 * the export's frozen copy is not worth keeping in a document.
 */
const LIVE_MACROS = [
  "childpages-macro",
  "plugin-contributors",
  "plugin_pagetree",
  "toc-macro",
  "client-side-toc-macro",
];

function confluenceRule(links: Links, report: Report, url: string): Rule {
  return (el: Element): ReturnType<Rule> => {
    const { tag, classes } = el;

    if (LIVE_MACROS.some((name) => classes.has(name))) {
      report.drop(`macro:${LIVE_MACROS.find((name) => classes.has(name))}`);
      return "drop";
    }

    if (tag === "img") {
      const src = el.attr("src") ?? "";
      const glyph = emoticon(src, el.attr("alt") ?? "");
      if (glyph) return { inline: glyph };
      // The bullets of the attachment list and the placeholder tiles the
      // view-file macro renders are export furniture, not content.
      if (/^images\/icons\//.test(src) || /placeholder-|view-file-macro/.test(src)) {
        return "drop";
      }
      // An emoji served by a plugin redirector, with the character itself only
      // in the query string.
      if (src.startsWith("plugins/servlet/")) {
        report.drop("plugin emoji");
        return { inline: escapeText(el.attr("alt") ?? "") };
      }
      // An office-document preview is generated on demand and is not in the
      // export; the link beside it still is.
      if (src.startsWith("rest/documentConversion/")) {
        report.drop("thumbnail");
        return "drop";
      }
      // The schema refuses an inlined image — it would be copied into every
      // revision and every collaborator's document — so it is uploaded like any
      // other attachment instead.
      const inline = /^data:(?:data:)?image\/[\w.+-]+;base64,(.+)$/s.exec(src);
      if (inline) {
        const stored = links.inlineImage(inline[1] as string);
        if (stored) return { tag: "img", attrs: { src: stored } };
      }
      if (src.startsWith("data:")) {
        report.drop("inline data: image");
        return "drop";
      }
      const uploaded = links.attachment(src);
      if (uploaded) return { tag: "img", attrs: { src: uploaded } };
      if (/^https?:\/\//.test(src)) return null;
      report.unresolvedAttachments.add(src);
      return "drop";
    }

    if (tag === "a") {
      const href = el.attr("href") ?? "";
      // The view-file macro renders a tile linking to the attachment; the schema
      // has a node for exactly that.
      if (classes.has("confluence-embedded-file")) {
        const filename =
          el.attr("data-linked-resource-default-alias") || el.text().trim() || "file";
        const uploaded = links.attachment(href);
        if (uploaded) {
          return {
            block: `<file-attachment src="${escapeAttr(uploaded)}" filename="${escapeAttr(filename)}"></file-attachment>`,
          };
        }
        report.unresolvedAttachments.add(href);
        return "drop";
      }

      const profile = /(?:^|\/)display\/~([^/?#]+)/.exec(href);
      if (profile) return { inline: mention(decodeURIComponent(profile[1] as string)) };

      const uploaded = links.attachment(href);
      if (uploaded) return { tag: "a", attrs: { href: uploaded } };

      const page = links.page(href);
      if (page) return { tag: "a", attrs: { href: page } };

      if (/\.html(?:[?#]|$)/.test(href) && !/^https?:/.test(href)) {
        // A page that was not part of the export; the wiki still has it.
        report.unresolvedPages.add(href);
        return url
          ? {
              tag: "a",
              attrs: {
                href: `${url}/pages/viewpage.action?pageId=${/(\d+)\.html/.exec(href)?.[1] ?? ""}`,
              },
            }
          : "unwrap";
      }
      if (!href || href.startsWith("#")) return "unwrap";
      return null;
    }

    if (tag === "span") {
      if (classes.has("status-macro")) return { inline: lozenge(classes, el.text()) };
      if (classes.has("companion-edit-button-placeholder")) return "drop";
      if (classes.has("confluence-embedded-file-wrapper")) return "unwrap";
      if (classes.has("placeholder-inline-tasks")) return "unwrap";
      if (classes.has("aui-icon")) return "drop";
      return null;
    }

    if (tag === "iframe") {
      const src = el.attr("src");
      // An iframe's whole content is its URL, so unwrapping it dropped all of it.
      return src
        ? { block: `<p><a href="${escapeAttr(src)}">${escapeText(src)}</a></p>` }
        : "drop";
    }

    if (tag === "time") {
      const date = el.attr("datetime");
      return date
        ? { inline: `<date-picker data-date="${escapeAttr(date)}"></date-picker>` }
        : "unwrap";
    }

    if (tag === "ul" && classes.has("inline-task-list")) {
      return { tag: "ul", attrs: { "data-type": "taskList" } };
    }
    if (tag === "li" && el.attr("data-inline-task-id")) {
      return {
        tag: "li",
        attrs: {
          "data-type": "taskItem",
          "data-checked": String(classes.has("checked")),
        },
      };
    }

    if (tag === "pre") {
      // `brush: java; gutter: false` — the first entry names the language.
      const brush = /brush:\s*([\w+#-]+)/.exec(
        el.attr("data-syntaxhighlighter-params") ?? "",
      );
      return brush
        ? { tag: "pre", attrs: { "data-language": brush[1] as string } }
        : null;
    }

    if (tag === "div") {
      const layout = [...classes].find((name) => name in COLUMN_COUNTS);
      if (classes.has("columnLayout") && layout) {
        const cells = el.childElements().filter((child) => child.classes.has("cell"));
        const columns = COLUMN_COUNTS[layout] as number;
        // A one-column "layout" is just a wrapper, and a column layout the
        // schema keeps needs at least two items.
        if (columns < 2 || cells.length < 2) {
          report.flatten("columnLayout");
          return "unwrap";
        }
        const items = cells
          .map((cell) => `<div data-type="column-item">${cell.inner()}</div>`)
          .join("");
        return {
          block: `<div data-type="column-layout" data-columns="${cells.length}">${items}</div>`,
        };
      }
      if (classes.has("confluence-information-macro")) {
        const kind = [...classes]
          .map((name) => /^confluence-information-macro-(\w+)$/.exec(name)?.[1])
          .find((name) => name && name !== "body");
        const label = kind
          ? `<p><strong>${escapeText(kind[0].toUpperCase() + kind.slice(1))}</strong></p>`
          : "";
        return { block: `<blockquote>${label}${el.inner()}</blockquote>` };
      }
      if (classes.has("aui-message"))
        return { block: `<blockquote>${el.inner()}</blockquote>` };
      if (classes.has("expand-control")) {
        const label = el
          .text()
          .replace(/^\s*(Click here to )?expand\s*/i, "")
          .trim();
        return label ? { block: `<p><strong>${escapeText(label)}</strong></p>` } : "drop";
      }
      // Every other Confluence div is presentational: table wrappers, cell
      // padding, code panel chrome. Unwrapping keeps the content and keeps the
      // parser from freezing the wrapper into the document as an `htmlBlock`.
      return "unwrap";
    }

    return null;
  };
}

/** The comment thread, appended so an HTML export does not lose it. */
function commentsSection(page: Page, rule: Rule): string {
  if (page.comments.length === 0) return "";
  const parts = [`<h2>Kommentare</h2>`];
  for (const comment of page.comments) {
    const byline = [comment.author, comment.posted].filter(Boolean).join(" · ");
    const body = cleanHtml(
      comment.body.map((node) => reserialize(node)).join(""),
      rule,
    ).html;
    parts.push(
      `<blockquote><p><strong>${escapeText(byline)}</strong></p>${body}</blockquote>`,
    );
  }
  return parts.join("");
}

/** Serializes a parsed node back to source, for a subtree cleaned separately. */
function reserialize(node: HtmlNode): string {
  if (node.type === SyntaxKind.Text) return node.value;
  const tag = node as HtmlTagNode;
  const name = tag.name;
  const attrs = (tag.attributes ?? [])
    .map((entry) =>
      entry.value === undefined
        ? entry.name.value
        : `${entry.name.value}="${entry.value.value.replaceAll('"', "&quot;")}"`,
    )
    .join(" ");
  const open = `<${name}${attrs ? ` ${attrs}` : ""}>`;
  if (!tag.body) return open;
  return `${open}${tag.body.map(reserialize).join("")}</${name}>`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const report = new Report();

  const details = readIndex(options.exportDir);
  const name = options.name || details.name;
  const slug = slugify(options.slug || transliterate(details.key));
  if (!slug) throw new Error("Space slug must contain at least one letter or number");
  const out = resolve(options.out || `./${slug}.db`);
  if (existsSync(out)) throw new Error(`Output database already exists: ${out}`);
  assertSlugAvailable(slug);

  console.log(`Reading ${options.exportDir} (${name}, key ${details.key})`);

  const files = readdirSync(options.exportDir)
    .filter((file) => file.endsWith(".html") && file !== "index.html")
    .sort();
  const indexed = new Set(details.tree.keys());
  for (const file of files) {
    if (!indexed.has(file)) report.residue.push(`${file}: not listed in index.html`);
  }

  const wanted = options.limit ? files.slice(0, options.limit) : files;
  const pages = new Map<string, Page>();
  for (const file of wanted)
    pages.set(file, readPage(options.exportDir, file, details.name));

  // Hierarchy from the index, with the path built out of page ids: two sibling
  // pages may carry the same title, and a path has to identify a page.
  const assign = (file: string, prefix: string[]): void => {
    const page = pages.get(file);
    const path = page ? [...prefix, page.id] : prefix;
    if (page) page.path = path;
    for (const child of details.tree.get(file) ?? []) assign(child, path);
  };
  for (const root of details.roots) assign(root, []);
  for (const page of pages.values()) {
    if (page.path.length === 0) page.path = [page.id];
  }

  // Attachments first: no document exists yet, so this half is safe to retry.
  const plan: SpacePlan<Page> = planSpace([...pages.values()], slug, report);
  const uploadsRoot = join(options.uploads, plan.spaceId);
  const uploads = new UploadStore(uploadsRoot, plan.spaceId, options.maxAttachmentBytes);

  /** Local attachment path as written in a link -> upload URL. */
  const uploaded = new Map<string, string>();
  /** `<pageId>/<filename>` -> upload URL, for the absolute download links. */
  const byFilename = new Map<string, string>();

  const names = new Map<string, string>();
  for (const page of pages.values()) {
    for (const attachment of page.attachments)
      names.set(attachment.href, attachment.filename);
  }

  const attachmentsDir = join(options.exportDir, "attachments");
  if (existsSync(attachmentsDir)) {
    for (const container of readdirSync(attachmentsDir)) {
      const dir = join(attachmentsDir, container);
      if (!statSync(dir).isDirectory()) continue;
      for (const entry of readdirSync(dir)) {
        const href = `attachments/${container}/${entry}`;
        const filename = names.get(href) ?? entry;
        const url = uploads.add(readFileSync(join(dir, entry)), filename);
        if (!url) continue;
        uploaded.set(href, url);
        byFilename.set(`${container}/${filename}`, url);
      }
    }
  }
  console.log(`Parsed ${pages.size} pages, uploaded ${uploads.size} attachments`);

  const links: Links = {
    attachment: (href) => {
      const clean = decodeURIComponent(href.split(/[?#]/)[0] ?? "");
      const direct = uploaded.get(clean.replace(/^\.?\//, ""));
      if (direct) return direct;
      // Comments link attachments absolutely and by filename rather than by id.
      const download = /(?:^|\/)download\/attachments\/(\d+)\/(.+)$/.exec(clean);
      if (download) return byFilename.get(`${download[1]}/${download[2]}`) ?? null;
      return null;
    },
    page: (href) => {
      const clean = decodeURIComponent(href.split(/[?#]/)[0] ?? "");
      const target = plan.byPath.get(pathOf(clean));
      return target ? plan.docPath(target.slug) : null;
    },
    inlineImage: (data) => {
      const bytes = Buffer.from(data, "base64");
      return bytes.byteLength > 0 ? uploads.add(bytes, "inline-image.png") : null;
    },
  };

  /** A link names another page by its export file; documents are keyed by path. */
  const pathByFile = new Map<string, string>();
  for (const entry of plan.entries) {
    pathByFile.set(entry.page.file, pathKey(entry.page.path));
  }
  function pathOf(file: string): string {
    return pathByFile.get(basename(file)) ?? "";
  }

  const rule = confluenceRule(links, report, options.confluenceUrl);
  const unwrapped = new Map<string, number>();
  const bodies = new Map<string, string>();
  let commented = 0;

  for (const entry of plan.entries) {
    const page = entry.page;
    const source = page.body.map(reserialize).join("");
    const cleaned = cleanHtml(source, rule);
    for (const [name, count] of cleaned.unwrapped) {
      unwrapped.set(name, (unwrapped.get(name) ?? 0) + count);
    }
    let html = cleaned.html;
    if (options.comments && page.comments.length > 0) {
      html += commentsSection(page, rule);
      commented++;
    }
    // The editor's Yjs sync plugin deletes schema-invalid nodes rather than
    // failing, so content that is not already normalized would silently lose
    // data the first time the document is opened.
    const body = docToHtml(htmlToDoc(html || "<p></p>"));
    if (docToHtml(htmlToDoc(body)) !== body) {
      throw new Error(`${page.file}: content is not stable under normalization`);
    }
    validate(page.file, body, report);
    bodies.set(entry.id, body);
  }

  for (const [name, count] of unwrapped) report.flatten(`<${name}>`, count);
  for (const [name, count] of unknownEntities) report.drop(`&${name};`, count);
  if (commented) console.log(`Appended comment threads on ${commented} pages`);

  const result = await writeSpace(
    plan,
    bodies,
    uploads,
    { out, name, owner: options.owner, dropWrapper: options.dropRoot },
    report,
  );
  printSummary(
    plan,
    result,
    uploads,
    { out, name, owner: options.owner, uploadsRoot },
    report,
  );
  if (uploadsRoot !== join(resolve("./data/uploads"), plan.spaceId)) {
    console.log(`  mv ${uploadsRoot} data/uploads/${plan.spaceId}`);
  }
}

/** Nothing may reach the database still pointing into the export directory. */
function validate(file: string, html: string, report: Report): void {
  for (const [pattern, what] of [
    [/(?:src|href)="(?!https?:|mailto:|tel:|\/)[^"]*\.html/, "a link into the export"],
    [/(?:src|href)="attachments\//, "a local attachment path"],
    [/(?:src|href)="images\/icons\//, "an export icon"],
    [/<html-block/, "markup the schema has no node for"],
  ] as [RegExp, string][]) {
    if (pattern.test(html)) report.residue.push(`${file}: ${what}`);
  }
}

await main();
