/**
 * Source pages -> a standalone Vektor space database.
 *
 * The half every wiki importer has in common: naming, hierarchy, categories,
 * and the row writing. What differs between a XAR, a Confluence HTML export and
 * an XWiki HTML export is only how pages and their bodies are *read*, so that
 * part stays in the per-format script and this module takes over once a page is
 * a title, a path, two dates and a body.
 *
 * Split in two because bodies cannot be converted before naming: a link to
 * another page has to name that page's final slug, which only exists after
 * every page has been given one. So a caller plans, converts against the plan,
 * then writes.
 */

import { Database as SqliteDatabase } from "bun:sqlite";
import { existsSync } from "node:fs";
import { sql } from "drizzle-orm";
import {
  closeDatabase,
  createDatabase,
  getAuthDatabaseUrl,
  getDatabaseFilePath,
} from "#db/client/connection.ts";
import { initSpaceDbSchema } from "#db/client/init.ts";
import { createId } from "#db/ids.ts";
import {
  acl,
  category,
  document,
  file,
  preference,
  property,
  spaceMetadata,
} from "#db/schema/space.ts";
import { buildDocumentSearchText } from "#search/embedding.ts";
import { htmlToPlainText } from "#utils/html.ts";
import { slugify } from "#utils/slug.ts";
import { spacePreferenceKeys } from "#utils/spacePreferences.ts";
import type { UploadStore } from "./uploads.ts";

// ---------------------------------------------------------------------------
// Source shape
// ---------------------------------------------------------------------------

export interface SourcePage {
  /** Identity in the source system, used for diagnostics and body lookup. */
  key: string;
  /** Nesting path, the last segment being the page itself. */
  path: string[];
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlannedPage<T extends SourcePage = SourcePage> {
  id: string;
  slug: string;
  page: T;
}

/** Path as a map key; a NUL cannot occur in a path segment. */
export function pathKey(path: string[]): string {
  return path.join("\u0000");
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/**
 * What the import could not carry over. Reported rather than dropped quietly:
 * unresolved page links are expected (they point outside the export) but an
 * unresolved attachment would mean a lost image.
 */
export class Report {
  readonly unresolvedAttachments = new Set<string>();
  readonly unresolvedPages = new Set<string>();
  readonly residue: string[] = [];
  /** Constructs thrown away, by name — the only trace that content went missing. */
  readonly dropped = new Map<string, number>();
  /** Constructs whose body was kept but whose meaning (layout, framing) was not. */
  readonly flattened = new Map<string, number>();
  suffixedSlugs = 0;
  keptSections = 0;
  /** Title of the export's wrapper page, when it had a body of its own. */
  orphanedWrapper: string | null = null;
  /** Whether that wrapper page was dropped rather than stored uncategorised. */
  wrapperDropped = false;

  drop(name: string, count = 1): void {
    this.dropped.set(name, (this.dropped.get(name) ?? 0) + count);
  }

  flatten(name: string, count = 1): void {
    this.flattened.set(name, (this.flattened.get(name) ?? 0) + count);
  }
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * `slugify` maps anything non-ASCII to a separator, which turns German page
 * titles into holes ("Aufräumtag" -> "aufr-umtag"). Folding the diacritics off
 * first keeps the URL readable.
 */
export function transliterate(value: string): string {
  return value
    .replace(/ß/g, "ss")
    .replace(/æ/gi, "ae")
    .replace(/ø/gi, "o")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

/**
 * Wiki page titles repeat across branches ("Dokumentation", "Tasks"), so a
 * collision is normal rather than an error, and is resolved the same way
 * `createDocument` resolves one: by suffixing.
 */
function uniqueSlug(title: string, taken: Set<string>, report: Report): string {
  const base = slugify(transliterate(title)) || "page";
  let slug = base;
  for (let counter = 1; taken.has(slug); counter++) slug = `${base}-${counter}`;
  if (slug !== base) report.suffixedSlugs++;
  taken.add(slug);
  return slug;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export interface SpacePlan<T extends SourcePage = SourcePage> {
  spaceId: string;
  spaceSlug: string;
  /** Shallowest first, so a parent always precedes its children. */
  entries: PlannedPage<T>[];
  byPath: Map<string, PlannedPage<T>>;
  /**
   * Pages by their path below the root. Links in an export are written against
   * the *source* wiki's root, which is not the root the subtree was exported
   * under, so the suffix is what actually identifies a page. Ambiguous suffixes
   * map to null rather than to an arbitrary one of their candidates.
   */
  bySuffix: Map<string, PlannedPage<T> | null>;
  /**
   * Nearest ancestor being written; `skip` holds pages replaced by a category.
   * `minDepth` is a floor on how far up the search may walk, so a page can be
   * kept from re-parenting outside its own section.
   */
  parentOf(page: T, skip?: Set<string>, minDepth?: number): string | null;
  /** The branches that become categories. */
  sections: PlannedPage<T>[];
  /** The section whose subtree holds this page, if any. */
  sectionOf(page: T): PlannedPage<T> | null;
  docPath(slug: string): string;
}

/** The space id, for a caller that has to upload attachments before it can plan. */
export function newSpaceId(): string {
  return createId("space");
}

export function planSpace<T extends SourcePage>(
  pages: T[],
  spaceSlug: string,
  report: Report,
  spaceId = newSpaceId(),
): SpacePlan<T> {
  // Shallowest first so a parent always has its slug before its children, and
  // so slug collisions resolve in favour of the higher page.
  const ordered = [...pages].sort(
    (a, b) => a.path.length - b.path.length || a.key.localeCompare(b.key),
  );

  const taken = new Set<string>();
  const byPath = new Map<string, PlannedPage<T>>();
  for (const page of ordered) {
    page.title = page.title || page.path.at(-1) || "Untitled";
    byPath.set(pathKey(page.path), {
      id: createId("document"),
      slug: uniqueSlug(page.title, taken, report),
      page,
    });
  }

  const bySuffix = new Map<string, PlannedPage<T> | null>();
  for (const entry of byPath.values()) {
    const suffix = pathKey(entry.page.path.slice(1));
    if (suffix) bySuffix.set(suffix, bySuffix.has(suffix) ? null : entry);
  }

  const parentOf = (page: T, skip?: Set<string>, minDepth = 1): string | null => {
    for (
      let path = page.path.slice(0, -1);
      path.length >= minDepth;
      path = path.slice(0, -1)
    ) {
      const ancestor = byPath.get(pathKey(path));
      if (ancestor && !skip?.has(ancestor.id)) return ancestor.id;
    }
    return null;
  };

  /**
   * The sidebar is built from categories, not from the raw tree: it lists
   * categories and asks for each one's documents, and a document with no
   * categorised ancestor never appears. So the branches of the tree become the
   * categories.
   *
   * One level below the root, not the root itself — an export usually hangs
   * everything off a single home page, which would make one category holding
   * the whole space. An export with several top-level pages uses those instead.
   */
  const entries = [...byPath.values()];
  const roots = entries.filter((entry) => parentOf(entry.page) === null);
  const sections =
    roots.length === 1
      ? entries.filter((entry) => parentOf(entry.page) === roots[0].id)
      : roots;
  sections.sort((a, b) => a.page.title.localeCompare(b.page.title));

  const sectionPaths = new Map(
    sections.map((section) => [pathKey(section.page.path), section]),
  );
  const sectionOf = (page: T): PlannedPage<T> | null => {
    for (let path = page.path; path.length > 0; path = path.slice(0, -1)) {
      const section = sectionPaths.get(pathKey(path));
      if (section) return section;
    }
    return null;
  };

  return {
    spaceId,
    spaceSlug,
    entries,
    byPath,
    bySuffix,
    parentOf,
    sections,
    sectionOf,
    docPath: (slug) => `/${spaceSlug}/doc/${slug}`,
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * `space_index` holds a unique index over active slugs, and local databases are
 * indexed before missing ones are pruned — so a duplicate slug does not degrade
 * to "this space fails to load", it aborts startup for the whole server. Far
 * better to refuse here than to hand over a database that bricks the install.
 */
export function assertSlugAvailable(slug: string): void {
  const authPath = getDatabaseFilePath(getAuthDatabaseUrl());
  // A remote auth database is not ours to inspect; the check simply does not run.
  if (!authPath || !existsSync(authPath)) return;

  const auth = new SqliteDatabase(authPath, { readonly: true });
  try {
    const taken = auth
      .query("select space_id from space_index where slug = ? and status = 'active'")
      .get(slug) as { space_id: string } | null;
    if (taken) {
      throw new Error(
        `Space slug "${slug}" is already used by ${taken.space_id} in ${authPath}. ` +
          "Pass a different --slug.",
      );
    }
  } finally {
    auth.close();
  }
}

/**
 * Reads the finished file back through a separate connection and counts what is
 * actually in it. Catches the failure this kind of script is most exposed to:
 * content still sitting in a journal sidecar rather than in the file being
 * handed over.
 */
function verifyWritten(path: string, expected: Record<string, number>): void {
  const check = new SqliteDatabase(path, { readonly: true });
  try {
    for (const [table, want] of Object.entries(expected)) {
      const { n } = check.query(`select count(*) as n from ${table}`).get() as {
        n: number;
      };
      if (n !== want) {
        throw new Error(`Wrote ${want} ${table} rows but the database holds ${n}`);
      }
    }
  } finally {
    check.close();
  }
}

/**
 * Whether a converted body holds nothing a reader would miss. Normalisation
 * gives an empty document one empty paragraph, and a page can also be nothing
 * but blank paragraphs and breaks — but a table or an image with no text at all
 * is still content.
 */
export function isBlank(html: string): boolean {
  if (/<(img|table|pre|video|file-attachment|hr|html-block)\b/.test(html)) return false;
  return htmlToPlainText(html).trim() === "";
}

export interface WriteOptions {
  out: string;
  name: string;
  owner: string;
  /**
   * Drop the export's wrapper page even when it has a body. No category can
   * cover it, so it is unreachable in the sidebar either way; this says its text
   * (usually the wiki's own "your space was created" placeholder) is not worth
   * keeping. What was dropped is always reported.
   */
  dropWrapper?: boolean;
}

export interface WriteResult {
  documents: number;
  categories: number;
  replaced: number;
}

/**
 * Writes the planned space. `bodies` maps a planned page's id to its finished
 * HTML, which must already carry upload URLs — nothing here rewrites content.
 */
export async function writeSpace<T extends SourcePage>(
  plan: SpacePlan<T>,
  bodies: Map<string, string>,
  uploads: UploadStore,
  options: WriteOptions,
  report: Report,
): Promise<WriteResult> {
  const now = new Date();
  const db = createDatabase(`file:${options.out}`);
  await initSpaceDbSchema(db, { local: true });

  await db.insert(spaceMetadata).values({
    id: plan.spaceId,
    name: options.name,
    slug: plan.spaceSlug,
    createdBy: options.owner,
    createdAt: now,
    updatedAt: now,
  });

  for (const [key, value] of Object.entries({
    brandColor: "#1e293b",
    [spacePreferenceKeys.workflowCreationEnabled]: "true",
  })) {
    await db
      .insert(preference)
      .values({ id: createId("preference"), key, value, createdAt: now, updatedAt: now });
  }

  await db.insert(acl).values({
    resourceType: "space",
    resourceId: plan.spaceId,
    userId: options.owner,
    permission: "owner",
    createdAt: now,
    updatedAt: now,
  });

  /**
   * A branch page that only ever existed to hold its children is replaced by
   * its category rather than stored beside it — otherwise the sidebar shows
   * "Dienstleister" nested inside the "Dienstleister" category. A branch page
   * that carries text of its own is kept: the category cannot hold a body, and
   * dropping the page would delete content.
   */
  const replaced = new Set(
    plan.sections
      .filter((section) => isBlank(bodies.get(section.id) ?? ""))
      .map((section) => section.id),
  );
  report.keptSections = plan.sections.length - replaced.size;

  /**
   * The page the whole export hangs off is a wrapper, not a section, so no
   * category covers it and the sidebar cannot show it. An empty one is dropped
   * like a branch page; one with a body is kept and reported, because deleting
   * text is worse than storing a document only search and links can reach.
   */
  const roots = plan.entries.filter((entry) => plan.parentOf(entry.page) === null);
  // `planSpace` only makes the sections the root's children when there is exactly
  // one root; with several roots the sections *are* the roots and none is a wrapper.
  const wrapper =
    roots.length === 1 && !plan.sections.includes(roots[0] as PlannedPage<T>)
      ? (roots[0] as PlannedPage<T>)
      : null;
  if (wrapper) {
    const empty = isBlank(bodies.get(wrapper.id) ?? "");
    if (empty || options.dropWrapper) replaced.add(wrapper.id);
    if (!empty) {
      report.orphanedWrapper = wrapper.page.title;
      report.wrapperDropped = options.dropWrapper === true;
    }
  }

  for (const [order, section] of plan.sections.entries()) {
    await db.insert(category).values({
      id: createId("category"),
      name: section.page.title,
      slug: section.slug,
      description: null,
      color: null,
      icon: null,
      order,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * Which document names each category. For a kept branch page that is the page
   * itself; for a replaced one it is each of its former children, which is as
   * high as the category can now be pinned.
   */
  const categoryOf = new Map<string, string>();
  for (const section of plan.sections) {
    if (!replaced.has(section.id)) {
      categoryOf.set(section.id, section.slug);
      continue;
    }
    for (const entry of plan.byPath.values()) {
      if (plan.parentOf(entry.page) === section.id)
        categoryOf.set(entry.id, section.slug);
    }
  }

  for (const { id, slug, page } of plan.byPath.values()) {
    if (replaced.has(id)) continue;

    const body = bodies.get(id) ?? "";
    const properties: Record<string, string> = { title: page.title };
    const sectionSlug = categoryOf.get(id);
    if (sectionSlug) properties.category = sectionSlug;

    /**
     * The search for a parent stops at the section, because the category has
     * taken the section page's place. Letting it walk further up would re-parent
     * every subtree onto the export's wrapper page, which then shows up as a
     * node inside every single category.
     */
    const section = plan.sectionOf(page);
    const parentId = plan.parentOf(page, replaced, section?.page.path.length ?? 1);

    await db.insert(document).values({
      id,
      slug,
      type: null,
      content: body,
      searchText: buildDocumentSearchText(body, properties),
      currentRev: 0,
      publishedRev: null,
      parentId,
      archived: false,
      readonly: false,
      createdBy: options.owner,
      createdAt: page.createdAt,
      updatedAt: page.updatedAt,
    });

    for (const [key, value] of Object.entries(properties)) {
      await db.insert(property).values({
        id: createId("property"),
        documentId: id,
        key,
        value,
        type: null,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      });
    }
  }

  for (const upload of uploads.rows()) {
    await db.insert(file).values({
      path: upload.key,
      documentId: null,
      originalName: upload.name,
      mimeType: upload.mimeType,
      url: upload.url,
      updatedAt: now,
      extractedText: null,
    });
  }

  // `initSpaceDbSchema` puts the database in WAL mode, which parks recent
  // writes in a `-wal` sidecar. The whole point of this script is a file you
  // move somewhere else, and moving the `.db` alone would silently leave the
  // tail of the import behind. Fold it back in and leave a single file; the
  // server re-enables WAL when it opens the database.
  await db.run(sql.raw("PRAGMA wal_checkpoint(TRUNCATE)"));
  await db.run(sql.raw("PRAGMA journal_mode = DELETE"));
  closeDatabase(db);

  const documents = plan.byPath.size - replaced.size;
  verifyWritten(options.out, {
    document: documents,
    category: plan.sections.length,
    file: uploads.size,
  });

  return { documents, categories: plan.sections.length, replaced: replaced.size };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export function printSummary(
  plan: SpacePlan,
  result: WriteResult,
  uploads: UploadStore,
  options: WriteOptions & { uploadsRoot: string },
  report: Report,
): void {
  console.log(`\nWrote ${options.out}`);
  console.log(`  space     ${options.name} (${plan.spaceSlug}), id ${plan.spaceId}`);
  console.log(`  owner     ${options.owner}`);
  console.log(
    `  documents ${result.documents} in ${result.categories} categories` +
      ` (${result.replaced} empty branch pages replaced by their category)`,
  );
  console.log(
    `  uploads   ${uploads.size} in ${options.uploadsRoot}` +
      (uploads.skipped.length ? ` (${uploads.skipped.length} skipped as too large)` : ""),
  );

  if (report.orphanedWrapper) {
    console.log(
      report.wrapperDropped
        ? `  dropped the export's wrapper page "${report.orphanedWrapper}" and its text, as asked`
        : `  "${report.orphanedWrapper}" is the export's wrapper page and has its own text,` +
            " so it is stored but sits under no category",
    );
  }
  if (report.keptSections) {
    console.log(
      `  ${report.keptSections} branch pages kept as documents because they have their own text`,
    );
  }
  if (report.suffixedSlugs) {
    console.log(`  ${report.suffixedSlugs} duplicate titles got a numbered slug`);
  }
  if (report.unresolvedPages.size) {
    console.log(
      `  ${report.unresolvedPages.size} page links point outside the export and became plain text:`,
    );
    for (const ref of [...report.unresolvedPages].slice(0, 5))
      console.log(`      ${ref}`);
  }
  if (report.flattened.size) {
    const flat = [...report.flattened].sort((a, b) => b[1] - a[1]);
    console.log(
      `  flattened (body kept, framing lost): ${flat
        .map(([name, n]) => `${name} (${n})`)
        .join(", ")}`,
    );
  }
  if (report.dropped.size) {
    const dropped = [...report.dropped].sort((a, b) => b[1] - a[1]);
    console.log(`  dropped: ${dropped.map(([name, n]) => `${name} (${n})`).join(", ")}`);
  }
  if (report.residue.length) {
    console.log(`  ${report.residue.length} bodies still look like they hold markup:`);
    for (const note of report.residue.slice(0, 5)) console.log(`      ${note}`);
  }
  if (uploads.skipped.length) {
    console.log(`  skipped as too large:`);
    for (const name of uploads.skipped.slice(0, 5)) console.log(`      ${name}`);
  }
  if (report.unresolvedAttachments.size) {
    console.log(
      `  WARNING: ${report.unresolvedAttachments.size} attachment references did not resolve:`,
    );
    for (const name of [...report.unresolvedAttachments].slice(0, 10)) {
      console.log(`      ${name}`);
    }
  }

  console.log("\nInstall with:");
  console.log(`  mv ${options.out} data/spaces/${plan.spaceId}.db`);
  console.log("  # restart the server — local space databases are indexed on startup");
}
