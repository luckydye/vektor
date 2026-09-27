/**
 * XWiki HTML export -> Vektor space database.
 *
 *   bun run scripts/xwiki-html-to-space.ts <export-dir> [options]
 *
 * The input is what XWiki's "Export > HTML" produces: `pages/<reference>/
 * WebHome.html` holding the rendered page inside the full wiki skin, and
 * `attachment/<reference>/<filename>` beside it. That is a different export than
 * `xar-to-space.ts` reads — a XAR carries the wiki source and every attachment
 * as data, and should be preferred when it can be obtained. An HTML export has
 * only the current rendering, so this importer creates one revision per document.
 *
 * The page tree comes from the directory layout, which *is* the XWiki reference,
 * and the two dates come from the footer the skin prints. Everything else is the
 * same job as any other import: resolve the attachments, repoint the links, and
 * strip the skin down to what the document schema can hold.
 *
 * `docs/importer.md` governs imports over the CLI, which cannot create a space
 * and so does not apply directly here. Its substance does: every attachment is
 * uploaded and every body rewritten to its upload URL before a single document
 * row is inserted, and nothing is dropped quietly.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative, resolve, sep } from "node:path";
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
  limit: number;
  /** Drop the export's wrapper page even when it carries text of its own. */
  dropRoot: boolean;
}

function parseOptions(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) flags.set(arg.slice(2), argv[++i] ?? "");
    else positional.push(arg);
  }

  const exportDir = positional[0];
  if (!exportDir) {
    throw new Error(
      "Usage: bun run scripts/xwiki-html-to-space.ts <export-dir> " +
        "[--name <space name>] [--slug <space slug>] [--out <file.db>] " +
        "[--owner <user id>] [--uploads <dir>] [--max-attachment-mb <n>] " +
        "[--limit <n>] [--drop-root]",
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
    limit: Number(flags.get("limit") ?? 0),
    dropRoot: flags.has("drop-root"),
  };
}

// ---------------------------------------------------------------------------
// Reading the export
// ---------------------------------------------------------------------------

interface Page extends SourcePage {
  /** Export-relative file path, which is how other pages link to it. */
  file: string;
  body: HtmlNode[];
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

/**
 * `20.11.2015 12:31`, or `2015/11/20 12:31` on an English skin. The footer is
 * the only place an HTML export prints a date, so a page with neither stamp
 * cannot be dated and stops the run.
 */
function parseStamp(value: string): Date | null {
  const dotted = /(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(value);
  if (dotted) {
    return new Date(
      Date.UTC(
        Number(dotted[3]),
        Number(dotted[2]) - 1,
        Number(dotted[1]),
        Number(dotted[4] ?? 12),
        Number(dotted[5] ?? 0),
      ),
    );
  }
  const slashed = /(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s+(\d{1,2}):(\d{2}))?/.exec(value);
  if (slashed) {
    return new Date(
      Date.UTC(
        Number(slashed[1]),
        Number(slashed[2]) - 1,
        Number(slashed[3]),
        Number(slashed[4] ?? 12),
        Number(slashed[5] ?? 0),
      ),
    );
  }
  return null;
}

/** Every `WebHome.html` under `pages/`, export-relative and slash-separated. */
function pageFiles(dir: string): string[] {
  const root = join(dir, "pages");
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      // `WebPreferences.html` is the space's rights and settings sheet, not a page.
      else if (entry === "WebHome.html")
        found.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walk(root);
  return found.sort();
}

function readPage(dir: string, file: string): Page {
  const html = readFileSync(join(dir, file), "utf8");
  const root = parseHtml(html);

  const titleTag = findTag(root, (tag) => attr(tag, "id") === "document-title");
  const content = findTag(root, (tag) => attr(tag, "id") === "xwikicontent");
  if (!content) throw new Error(`${file}: no #xwikicontent`);

  const created = findTag(root, (tag) => hasClass(tag, "xdocCreation"));
  const modified = findTag(root, (tag) => hasClass(tag, "xdocLastModification"));
  const createdAt = created ? parseStamp(textOf(created.body ?? [])) : null;
  const updatedAt = modified ? parseStamp(textOf(modified.body ?? [])) : null;
  if (!createdAt && !updatedAt)
    throw new Error(`${file}: no readable date in the footer`);

  // The reference is the directory path; the trailing `WebHome` is the page
  // itself rather than a child of it.
  const path = file.split("/").slice(1, -1);
  return {
    key: file,
    file,
    path,
    title: titleTag ? textOf(titleTag.body ?? []).trim() : "",
    createdAt: createdAt ?? (updatedAt as Date),
    updatedAt: updatedAt ?? (createdAt as Date),
    body: content.body ?? [],
  };
}

/** Serializes a parsed node back to source, for a subtree cleaned separately. */
function reserialize(node: HtmlNode): string {
  if (node.type === SyntaxKind.Text) return node.value;
  const tag = node as HtmlTagNode;
  const attrs = (tag.attributes ?? [])
    .map((entry) =>
      entry.value === undefined
        ? entry.name.value
        : `${entry.name.value}="${entry.value.value.replaceAll('"', "&quot;")}"`,
    )
    .join(" ");
  const open = `<${tag.name}${attrs ? ` ${attrs}` : ""}>`;
  if (!tag.body) return open;
  return `${open}${tag.body.map(reserialize).join("")}</${tag.name}>`;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

interface Links {
  /** Candidate `attachment/...` paths -> upload URL. */
  attachment(paths: string[]): string | null;
  /** Candidate `pages/...` paths -> document path. */
  page(paths: string[]): string | null;
  /** Base64 image data -> upload URL. */
  inlineImage(data: string): string | null;
}

/**
 * The export-relative paths an href could mean, most-encoded first.
 *
 * A page name is stored URL-encoded in the export's directory names, and the
 * hrefs are inconsistent about it: a page link carries the encoding of that
 * already-encoded name (`S%2526V`), while an attachment link from some macros
 * carries only one layer (`S%26V`). Rather than guess, every decoding depth is
 * offered and the lookup takes the one that exists.
 */
function hrefPaths(file: string, href: string): string[] {
  const path = href.split(/[?#]/)[0] ?? "";
  if (!path || /^[a-zA-Z][\w+.-]*:/.test(path) || path.startsWith("//")) return [];
  const joined = posix.normalize(posix.join(posix.dirname(file), path));
  if (joined.startsWith("..")) return [];

  const candidates = [joined];
  for (let depth = 0; depth < 2; depth++) {
    const last = candidates[candidates.length - 1] as string;
    try {
      const decoded = decodeURIComponent(last);
      if (decoded === last) break;
      candidates.push(decoded);
    } catch {
      break;
    }
  }
  return candidates;
}

/** Live-query and skin furniture: no static equivalent, nothing to keep. */
const FURNITURE = [
  "xtree",
  "breadcrumb-tree",
  "dropdown-menu",
  "wikimodel-emptyline",
  "hidden",
  "sr-only",
  "tag-tool",
  "like-container",
  "annotation",
  "xwikirenderingerror",
];

function xwikiRule(links: Links, report: Report, file: string): Rule {
  return (el: Element): ReturnType<Rule> => {
    const { tag, classes } = el;

    if (FURNITURE.some((name) => classes.has(name))) {
      report.drop(`skin:${FURNITURE.find((name) => classes.has(name))}`);
      return "drop";
    }

    if (tag === "img") {
      const src = el.attr("src") ?? "";
      const glyph = emoticon(src, el.attr("alt") ?? "");
      if (glyph) return { inline: glyph };
      // An inlined image is refused by the schema — it would be copied into every
      // revision — so it is uploaded like any other attachment instead.
      const inline = /^data:(?:data:)?image\/[\w.+-]+;base64,(.+)$/s.exec(src);
      if (inline) {
        const uploaded = links.inlineImage(inline[1] as string);
        if (uploaded) return { tag: "img", attrs: { src: uploaded } };
        report.drop("inline data: image");
        return "drop";
      }
      if (src.startsWith("data:")) {
        report.drop("inline data: image");
        return "drop";
      }
      const paths = hrefPaths(file, src);
      const first = paths[0] ?? "";
      // Skin assets: icons and avatars the export ships for its own rendering.
      if (/^(resources|skins|webjars|ssx|jsx)\//.test(first)) return "drop";
      const uploaded = links.attachment(paths);
      if (uploaded) return { tag: "img", attrs: { src: uploaded } };
      if (/^https?:\/\//.test(src)) return null;
      if (first) report.unresolvedAttachments.add(paths.at(-1) as string);
      return "drop";
    }

    if (tag === "a") {
      const href = el.attr("href") ?? "";
      // A profile link is the one place the export names a user. XWiki cannot
      // hold a dot in a page name, so `p.reichard@s-v.de` is written
      // `p_reichard@s-v_de` and the underscores turn back into dots.
      const profile = /\/XWiki\/([^/?#]+)$/.exec(href);
      if (profile) {
        // A short account name has no address to key a mention on, so it becomes
        // the plain `@name` the wiki showed rather than a link into the old wiki.
        const name = decodeURIComponent(profile[1] as string).replace(/_/g, ".");
        return { inline: mention(name) };
      }
      // Links into the live wiki that only exist as an action there.
      if (/xwiki\.[^/]+\/wiki\/[^/]+\/(create|edit|view)\//.test(href)) {
        report.drop("wiki action link");
        return "unwrap";
      }

      const paths = hrefPaths(file, href);
      if (paths.length > 0) {
        const uploaded = links.attachment(paths);
        if (uploaded) return { tag: "a", attrs: { href: uploaded } };
        const page = links.page(paths);
        if (page) return { tag: "a", attrs: { href: page } };
        const shown = paths.at(-1) as string;
        if (shown.startsWith("pages/")) {
          report.unresolvedPages.add(shown);
          return "unwrap";
        }
        if (shown.startsWith("attachment/")) {
          report.unresolvedAttachments.add(shown);
          return "unwrap";
        }
      }
      if (!href || href.startsWith("#")) return "unwrap";
      return null;
    }

    if (tag === "span") {
      if (classes.has("statusBox") || classes.has("status-macro")) {
        return { inline: lozenge(classes, el.text()) };
      }
      // Font-awesome glyphs are the skin's icons; the label beside them stays.
      if ([...classes].some((name) => name === "fa" || name.startsWith("fa-")))
        return "drop";
      if (classes.has("wikilink") || classes.has("wikiexternallink")) return "unwrap";
      return null;
    }

    if (tag === "iframe") {
      const src = el.attr("src");
      // An iframe's whole content is its URL, so dropping the element dropped
      // all of it.
      return src
        ? { block: `<p><a href="${escapeAttr(src)}">${escapeText(src)}</a></p>` }
        : "drop";
    }

    if (tag === "pre") {
      const language = /\blanguage-([\w+#-]+)/.exec(el.attr("class") ?? "");
      return language
        ? { tag: "pre", attrs: { "data-language": language[1] as string } }
        : null;
    }

    if (tag === "div") {
      // A task macro is a checkbox, an id link and a body — a checklist item.
      if (classes.has("task-macro")) {
        const box = el.find((child) => child.classes.has("task-status"));
        const checked = box.some((child) => child.attr("checked") !== null);
        const info = el.find((child) => child.classes.has("task-info"));
        const content = el.find((child) => child.classes.has("task-content"));
        const label = [
          ...content.map((child) => child.innerInline()),
          ...info.map((child) => child.innerInline()),
        ]
          .filter((part) => part.trim())
          .join(" ");
        return {
          block:
            `<ul data-type="taskList"><li data-type="taskItem" data-checked="${checked}">` +
            `<p>${label || " "}</p></li></ul>`,
        };
      }
      // An application form is a field/value sheet, which is a two-column table
      // once the bootstrap grid around it is gone.
      if (classes.has("xform")) {
        const rows = el
          .find((child) => child.tag === "dl")
          .map((list) => {
            const label = list
              .find((child) => child.tag === "dt")
              .map((child) => child.text().trim())
              .join(" ")
              .trim();
            const value = list
              .find((child) => child.tag === "dd")
              .map((child) => child.inner())
              .join("");
            return { label, value };
          })
          .filter((row) => row.label && row.value.trim());
        if (rows.length === 0) {
          report.drop("empty form");
          return "drop";
        }
        const body = rows
          .map(
            (row) =>
              `<tr><th><p>${escapeText(row.label)}</p></th><td>${row.value}</td></tr>`,
          )
          .join("");
        return { block: `<table>${body}</table>` };
      }
      // A progress bar's only content is the percentage it shows.
      if (classes.has("progress")) {
        const value = el.text().trim();
        return value ? { block: `<p>${escapeText(value)}</p>` } : "drop";
      }
      if (
        classes.has("box") ||
        classes.has("panel") ||
        [...classes].some((name) => /message$/.test(name))
      ) {
        const inner = el.inner();
        return inner ? { block: `<blockquote>${inner}</blockquote>` } : "drop";
      }
      // Everything else is bootstrap grid or skin padding.
      return "unwrap";
    }

    if (tag === "dl" || tag === "dt" || tag === "dd") {
      // A definition list outside a form has no node; its parts read as
      // paragraphs, with the term in bold.
      report.flatten(`<${tag}>`);
      if (tag === "dt") {
        const label = el.innerInline().trim();
        return label ? { block: `<p><strong>${label}</strong></p>` } : "drop";
      }
      return "unwrap";
    }

    return null;
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const report = new Report();

  const files = pageFiles(options.exportDir);
  if (files.length === 0) throw new Error("No pages/**/WebHome.html in the export");
  const wanted = options.limit ? files.slice(0, options.limit) : files;

  const pages = wanted.map((file) => readPage(options.exportDir, file));
  // The export root is whichever page every other one hangs off; its title names
  // the space unless the caller says otherwise.
  const shallowest = pages.reduce((a, b) => (b.path.length < a.path.length ? b : a));
  const name = options.name || shallowest.title || shallowest.path.at(-1) || "Wiki";
  const slug = slugify(options.slug || transliterate(name));
  if (!slug) throw new Error("Space slug must contain at least one letter or number");
  const out = resolve(options.out || `./${slug}.db`);
  if (existsSync(out)) throw new Error(`Output database already exists: ${out}`);
  assertSlugAvailable(slug);

  console.log(`Reading ${options.exportDir} (${pages.length} pages, space "${name}")`);

  const plan: SpacePlan<Page> = planSpace(pages, slug, report);
  const uploadsRoot = join(options.uploads, plan.spaceId);
  const uploads = new UploadStore(uploadsRoot, plan.spaceId, options.maxAttachmentBytes);

  /**
   * Attachments first: no document exists yet, so this half is safe to retry.
   * They sit under the page's *full* reference, trailing `WebHome` included, and
   * only under an imported page — `attachment/*​/XWiki/*` is the skin's own
   * material, which no page refers to.
   */
  const uploaded = new Map<string, string>();
  const attachmentsRoot = join(options.exportDir, "attachment");
  const upload = (path: string): string | null => {
    const file = join(options.exportDir, ...path.split("/"));
    if (!existsSync(file) || !statSync(file).isFile()) return null;
    const name = decodeURIComponent(path.split("/").pop() ?? "file");
    const url = uploads.add(readFileSync(file), name);
    if (url) uploaded.set(path, url);
    return url;
  };

  for (const entry of plan.entries) {
    const reference = [...entry.page.path, "WebHome"];
    const dir = join(attachmentsRoot, ...reference);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir)) {
      const key = ["attachment", ...reference, name].join("/");
      if (!uploaded.has(key)) upload(key);
    }
  }

  const links: Links = {
    attachment: (paths) => {
      for (const path of paths) {
        if (!path.startsWith("attachment/")) continue;
        // An attachment the walk above did not reach: one on a page outside the
        // export, or written at a different encoding depth than the directory.
        const url = uploaded.get(path) ?? upload(path);
        if (url) return url;
      }
      return null;
    },
    page: (paths) => {
      for (const path of paths) {
        if (!path.startsWith("pages/")) continue;
        const target = plan.byPath.get(pathKey(path.split("/").slice(1, -1)));
        if (target) return plan.docPath(target.slug);
      }
      return null;
    },
    inlineImage: (data) => {
      const bytes = Buffer.from(data, "base64");
      if (bytes.byteLength === 0) return null;
      return uploads.add(bytes, "inline-image.png");
    },
  };

  const unwrapped = new Map<string, number>();
  const bodies = new Map<string, string>();
  for (const entry of plan.entries) {
    const rule = xwikiRule(links, report, entry.page.file);
    const cleaned = cleanHtml(entry.page.body.map(reserialize).join(""), rule);
    for (const [name, count] of cleaned.unwrapped) {
      unwrapped.set(name, (unwrapped.get(name) ?? 0) + count);
    }
    // The editor's Yjs sync plugin deletes schema-invalid nodes rather than
    // failing, so content that is not already normalized would silently lose
    // data the first time the document is opened.
    const body = docToHtml(htmlToDoc(cleaned.html || "<p></p>"));
    if (docToHtml(htmlToDoc(body)) !== body) {
      throw new Error(`${entry.page.file}: content is not stable under normalization`);
    }
    validate(entry.page.file, body, report);
    bodies.set(entry.id, body);
  }

  for (const [name, count] of unwrapped) report.flatten(`<${name}>`, count);
  for (const [name, count] of unknownEntities) report.drop(`&${name};`, count);
  if (!existsSync(attachmentsRoot))
    console.log("  (no attachment/ directory in the export)");

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
    [
      /(?:src|href)="(?:\.\.?\/|pages\/|attachment\/|resources\/|skins\/)/,
      "a path into the export",
    ],
    [/(?:src|href)="data:/, "an inlined asset"],
    [/<html-block/, "markup the schema has no node for"],
  ] as [RegExp, string][]) {
    if (pattern.test(html)) report.residue.push(`${file}: ${what}`);
  }
}

await main();
