/**
 * Confluence import staging database -> Vektor space database. Stage 2 of 2.
 *
 *   bun run scripts/confluence-staging-to-space.ts [options]
 *
 * Reads the staging database written by `confluence-export-to-staging.py` and
 * produces a standalone space `.db` plus an uploads directory. The server picks
 * the space up on the next start: `reconcileLocalSpaceIndex` scans
 * `data/spaces/*.db`, so no auth-database edit is needed.
 *
 * The schema comes from `initSpaceDbSchema` and every row is written through
 * Drizzle, so column encodings are whatever the server itself writes rather than
 * something this script guesses at.
 *
 * Document and revision HTML is round-tripped through `htmlToDoc`/`docToHtml`
 * before it is stored. That is not cosmetic: the editor's Yjs sync plugin
 * *deletes* schema-invalid nodes rather than failing, so unnormalized content
 * would silently lose data the first time a page is opened. The round-trip also
 * fills in what the renderer owns — a `date-picker`'s visible label, canonical
 * attribute order — so stored content matches what a save would have produced.
 *
 * `docs/importer.md` governs imports over the CLI, which cannot create a space
 * and so does not apply directly. Its substance does: every attachment is
 * written and every body rewritten to its upload URL before a single document
 * row is inserted, `created`/`modified` are carried over, and nothing is dropped
 * quietly — anything unresolved is counted and reported at the end.
 *
 * See scripts/confluence-import.md.
 */

import { Database as SqliteDatabase } from "bun:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants } from "node:zlib";
import {
  closeDatabase,
  createDatabase,
  getLocalSpaceDatabaseUrl,
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
  revision,
  spaceMetadata,
} from "#db/schema/space.ts";
import { htmlToDoc } from "#documents/schema/parse.ts";
import { docToHtml } from "#documents/schema/render.ts";
import { buildDocumentSearchText } from "#search/embedding.ts";
import { spacePreferenceKeys } from "#utils/spacePreferences.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

interface Options {
  staging: string;
  spacesDir: string;
  uploadsDir: string;
  force: boolean;
}

function parseOptions(argv: string[]): Options {
  const flags = new Map<string, string>();
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") {
      force = true;
    } else if (arg.startsWith("--")) {
      flags.set(arg.slice(2), argv[++i] ?? "");
    }
  }
  const staging = resolve(flags.get("staging") ?? "data/confluence-staging");
  return {
    staging,
    spacesDir: resolve(flags.get("spaces") ?? "data/spaces"),
    uploadsDir: resolve(flags.get("uploads") ?? "data/uploads"),
    force,
  };
}

const options = parseOptions(process.argv.slice(2));

const stagingDbPath = join(options.staging, "staging.db");
const stagingUploads = join(options.staging, "uploads");
if (!existsSync(stagingDbPath)) {
  throw new Error(
    `staging database not found: ${stagingDbPath}\n` +
      `Run scripts/confluence-export-to-staging.py first.`,
  );
}

// ---------------------------------------------------------------------------
// Revision snapshots — must match app/src/db/space/revisions.ts
// ---------------------------------------------------------------------------

const brotliCompressAsync = promisify(brotliCompress);
const LARGE_PAYLOAD_BYTES = 512 * 1024;

async function compressHtml(html: string): Promise<Buffer> {
  const buffer = Buffer.from(html, "utf-8");
  const quality = buffer.byteLength > LARGE_PAYLOAD_BYTES ? 4 : 11;
  return await brotliCompressAsync(buffer, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.byteLength,
    },
  });
}

function checksumOf(html: string): string {
  return createHash("sha256").update(html, "utf-8").digest("hex");
}

/**
 * Stored content has to be what the schema round-trips to, or the editor drops
 * whatever it cannot parse on first open. An empty result would violate
 * `content NOT NULL`, so it falls back to an empty paragraph.
 */
function normalizeHtml(html: string): string {
  const normalized = docToHtml(htmlToDoc(html)).trim();
  return normalized || "<p></p>";
}

/** Drizzle timestamp columns take Date; the staging db holds epoch seconds. */
function at(epochSeconds: string): Date {
  return new Date(Number(epochSeconds) * 1000);
}

// ---------------------------------------------------------------------------
// Staging input
// ---------------------------------------------------------------------------

interface SpaceRow {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}
interface CategoryRow {
  id: string;
  name: string;
  slug: string;
  order: number;
  created_at: string;
  updated_at: string;
}
interface DocRow {
  id: string;
  slug: string;
  title: string;
  category: string | null;
  parent_id: string | null;
  content: string;
  current_rev: number;
  created_at: string;
  updated_at: string;
  created_by: string;
  position: number;
}
interface RevRow {
  id: string;
  document_id: string;
  rev: number;
  slug: string;
  html: string;
  parent_rev: number | null;
  message: string;
  created_at: string;
  created_by: string;
}
interface UploadRow {
  key: string;
  document_id: string | null;
  original_name: string;
  mime_type: string | null;
  url: string;
  updated_at: string;
}
interface AclRow {
  resource_type: string;
  resource_id: string;
  user_id: string | null;
  group_id: string | null;
  permission: string;
  created_at: string;
  updated_at: string;
}

const staging = new SqliteDatabase(stagingDbPath, { readonly: true });

const space = staging.query<SpaceRow, []>("SELECT * FROM space").get();
if (!space) throw new Error("staging database has no space row");

const categories = staging
  .query<CategoryRow, []>(
    'SELECT id, name, slug, "order", created_at, updated_at FROM cat ORDER BY "order"',
  )
  .all();
const docs = staging.query<DocRow, []>("SELECT * FROM doc ORDER BY position").all();
const uploads = staging.query<UploadRow, []>("SELECT * FROM upload").all();
const aclRows = staging.query<AclRow, []>("SELECT * FROM acl_row").all();
const revisionsFor = staging.query<RevRow, [string]>(
  "SELECT * FROM rev WHERE document_id = ? ORDER BY rev",
);

const spaceDbPath = join(options.spacesDir, `${space.id}.db`);
const spaceUploadsDir = join(options.uploadsDir, space.id);

console.log(`space      ${space.id}  (${space.name} / ${space.slug})`);
console.log(`target db  ${spaceDbPath}`);
console.log(`uploads    ${spaceUploadsDir}`);

// ---------------------------------------------------------------------------
// Guards — never write over an existing space
// ---------------------------------------------------------------------------

if (existsSync(spaceDbPath) && !options.force) {
  throw new Error(
    `target space database already exists: ${spaceDbPath}\n` +
      `Refusing to touch it. Delete it or pass --force to replace it.`,
  );
}

const authDbPath = join(dirname(options.spacesDir), "auth.db");
if (existsSync(authDbPath)) {
  const auth = new SqliteDatabase(authDbPath, { readonly: true });
  try {
    const clash = auth
      .query<{ n: number }, [string, string]>(
        `SELECT count(*) AS n FROM space_index
          WHERE status IN ('active','claimed') AND (slug = ? OR space_id = ?)`,
      )
      .get(space.slug, space.id);
    if (clash && clash.n > 0 && !options.force) {
      throw new Error(
        `auth.db already indexes an active space with slug "${space.slug}" or id ` +
          `${space.id}. Refusing to create a duplicate. Pass --force to proceed.`,
      );
    }
  } finally {
    auth.close();
  }
}

if (existsSync(spaceDbPath) && options.force) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const path = `${spaceDbPath}${suffix}`;
    if (existsSync(path)) rmSync(path);
  }
}
mkdirSync(options.spacesDir, { recursive: true });

// ---------------------------------------------------------------------------
// Uploads first: no document may reference a file that is not on disk yet
// ---------------------------------------------------------------------------

mkdirSync(spaceUploadsDir, { recursive: true });

// Storage is content-addressable, so identical bytes attached to two pages
// collapse to one key. `file.path` is the primary key, so index each key once,
// preferring a row that names a document.
const uploadByKey = new Map<string, UploadRow>();
let duplicatePayloads = 0;
for (const upload of uploads) {
  const existing = uploadByKey.get(upload.key);
  if (!existing) {
    uploadByKey.set(upload.key, upload);
    continue;
  }
  duplicatePayloads++;
  if (!existing.document_id && upload.document_id) uploadByKey.set(upload.key, upload);
}
const uniqueUploads = [...uploadByKey.values()];

let uploadBytes = 0;
for (const upload of uniqueUploads) {
  const source = join(stagingUploads, upload.key);
  if (!existsSync(source)) throw new Error(`staged upload missing: ${source}`);
  const target = join(spaceUploadsDir, upload.key);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  uploadBytes += statSync(target).size;
}
console.log(
  `uploads    ${uniqueUploads.length} files (${(uploadBytes / 1e6).toFixed(1)} MB)` +
    (duplicatePayloads ? `, ${duplicatePayloads} duplicate payload(s) deduplicated` : ""),
);

// ---------------------------------------------------------------------------
// Space database
// ---------------------------------------------------------------------------

const db = createDatabase(getLocalSpaceDatabaseUrl(space.id));
let created = 0;
let revisionCount = 0;
let rawBytes = 0;
let packedBytes = 0;
const documentIds = new Set(docs.map((doc) => doc.id));

try {
  await initSpaceDbSchema(db, { local: true });

  await db.insert(spaceMetadata).values({
    id: space.id,
    name: space.name,
    slug: space.slug,
    createdBy: space.created_by,
    createdAt: at(space.created_at),
    updatedAt: at(space.updated_at),
  });

  // The defaults createSpace() writes, so an imported space behaves like any other.
  for (const [key, value] of Object.entries({
    brandColor: "#1e293b",
    [spacePreferenceKeys.workflowCreationEnabled]: "true",
  })) {
    await db.insert(preference).values({
      id: createId("preference"),
      key,
      value,
      createdAt: at(space.created_at),
      updatedAt: at(space.updated_at),
    });
  }

  for (const row of categories) {
    await db.insert(category).values({
      id: row.id,
      name: row.name,
      slug: row.slug,
      order: row.order,
      createdAt: at(row.created_at),
      updatedAt: at(row.updated_at),
    });
  }
  console.log(`categories ${categories.length}`);

  for (const doc of docs) {
    const content = normalizeHtml(doc.content);
    const properties: Record<string, string> = { title: doc.title, layout: "document" };
    if (doc.category) properties.category = doc.category;

    // Documents arrive in tree order, so a parent always exists by the time a
    // child references it.
    if (doc.parent_id && !documentIds.has(doc.parent_id)) {
      throw new Error(`document ${doc.slug} references unknown parent ${doc.parent_id}`);
    }

    await db.insert(document).values({
      id: doc.id,
      slug: doc.slug,
      type: null,
      archived: false,
      readonly: false,
      content,
      // Populated so keyword search works before the first reindex; the
      // embedding is left null so the server's backfill still picks the row up.
      searchText: buildDocumentSearchText(content, properties),
      currentRev: doc.current_rev,
      publishedRev: doc.current_rev > 0 ? doc.current_rev : null,
      parentId: doc.parent_id,
      createdAt: at(doc.created_at),
      updatedAt: at(doc.updated_at),
      createdBy: doc.created_by,
    });

    for (const [key, value] of Object.entries(properties)) {
      await db.insert(property).values({
        id: createId("property"),
        documentId: doc.id,
        key,
        value,
        createdAt: at(doc.created_at),
        updatedAt: at(doc.updated_at),
      });
    }

    for (const rev of revisionsFor.all(doc.id)) {
      const html = normalizeHtml(rev.html);
      const snapshot = await compressHtml(html);
      rawBytes += Buffer.byteLength(html, "utf-8");
      packedBytes += snapshot.byteLength;
      await db.insert(revision).values({
        id: rev.id,
        documentId: rev.document_id,
        rev: rev.rev,
        slug: rev.slug,
        snapshot,
        checksum: checksumOf(html),
        parentRev: rev.parent_rev,
        status: null, // a normal save, not a suggestion
        message: rev.message,
        createdAt: at(rev.created_at),
        createdBy: rev.created_by,
      });
      revisionCount++;
    }

    created++;
    if (created % 25 === 0) {
      console.log(`  ${created}/${docs.length} documents, ${revisionCount} revisions`);
    }
  }
  console.log(`documents  ${created}`);
  console.log(
    `revisions  ${revisionCount}  (${(rawBytes / 1e6).toFixed(1)} MB html -> ` +
      `${(packedBytes / 1e6).toFixed(1)} MB brotli)`,
  );

  for (const upload of uniqueUploads) {
    await db.insert(file).values({
      path: upload.key,
      // A page that was dropped as an empty container leaves its attachments
      // standalone rather than pointing at a document that does not exist.
      documentId:
        upload.document_id && documentIds.has(upload.document_id)
          ? upload.document_id
          : null,
      originalName: upload.original_name,
      mimeType: upload.mime_type,
      url: upload.url,
      updatedAt: at(upload.updated_at),
    });
  }

  for (const row of aclRows) {
    await db.insert(acl).values({
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      userId: row.user_id,
      groupId: row.group_id ?? "",
      permission: row.permission,
      createdAt: at(row.created_at),
      updatedAt: at(row.updated_at),
    });
  }
  console.log(`acl        ${aclRows.length}`);
} finally {
  closeDatabase(db);
  staging.close();
}

// ---------------------------------------------------------------------------
// Validation — read the finished file back
// ---------------------------------------------------------------------------

const check = new SqliteDatabase(spaceDbPath, { readonly: true });
const count = (sql: string): number => check.query<{ n: number }, []>(sql).get()?.n ?? 0;

const checks: Array<[string, number, number]> = [
  ["documents", count("SELECT count(*) n FROM document"), docs.length],
  ["revisions", count("SELECT count(*) n FROM revision"), revisionCount],
  ["categories", count("SELECT count(*) n FROM category"), categories.length],
  ["files", count("SELECT count(*) n FROM file"), uniqueUploads.length],
  [
    "orphan parents",
    count(`SELECT count(*) n FROM document d WHERE d.parent_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM document p WHERE p.id = d.parent_id)`),
    0,
  ],
  [
    "revisions with no document",
    count(`SELECT count(*) n FROM revision r
             WHERE NOT EXISTS (SELECT 1 FROM document d WHERE d.id = r.document_id)`),
    0,
  ],
  [
    "files with no document",
    count(`SELECT count(*) n FROM file f WHERE f.document_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM document d WHERE d.id = f.document_id)`),
    0,
  ],
  [
    "duplicate slugs",
    count(
      "SELECT count(*) n FROM (SELECT slug FROM document GROUP BY slug HAVING count(*) > 1)",
    ),
    0,
  ],
  [
    "current_rev mismatch",
    count(`SELECT count(*) n FROM document d WHERE d.current_rev <>
             COALESCE((SELECT max(rev) FROM revision r WHERE r.document_id = d.id), 0)`),
    0,
  ],
  [
    "published_rev mismatch",
    count(
      "SELECT count(*) n FROM document WHERE current_rev > 0 AND published_rev <> current_rev",
    ),
    0,
  ],
  [
    "documents missing a title",
    count(`SELECT count(*) n FROM document d WHERE NOT EXISTS
             (SELECT 1 FROM property p WHERE p.document_id = d.id AND p.key = 'title')`),
    0,
  ],
  [
    "category property with no category",
    count(`SELECT count(*) n FROM property p WHERE p.key = 'category'
             AND NOT EXISTS (SELECT 1 FROM category c WHERE c.slug = p.value)`),
    0,
  ],
  [
    "empty content",
    count("SELECT count(*) n FROM document WHERE content IS NULL OR content = ''"),
    0,
  ],
  [
    "leftover confluence markup",
    count(
      "SELECT count(*) n FROM document WHERE content LIKE '%<ac:%' OR content LIKE '%<ri:%'",
    ),
    0,
  ],
];

// Every upload URL referenced by a document must be indexed and on disk.
const referenced = new Set<string>();
for (const row of check
  .query<{ content: string }, []>("SELECT content FROM document")
  .all()) {
  for (const match of row.content.matchAll(
    /\/api\/v1\/spaces\/[^/]+\/uploads\/([\w./-]+)/g,
  )) {
    referenced.add(match[1]);
  }
}
const indexed = new Set(uniqueUploads.map((upload) => upload.key));
const dangling = [...referenced].filter((key) => !indexed.has(key));
for (const key of dangling.slice(0, 5)) console.error(`  dangling upload: ${key}`);
checks.push(["dangling upload references", dangling.length, 0]);
checks.push([
  "referenced uploads missing on disk",
  [...referenced].filter((key) => !existsSync(join(spaceUploadsDir, key))).length,
  0,
]);

// Normalization has to be a fixed point: re-running it must not change stored
// content, or the editor would still have work to do on first open.
let unstable = 0;
for (const row of check
  .query<{ content: string }, []>("SELECT content FROM document")
  .all()) {
  if (normalizeHtml(row.content) !== row.content) unstable++;
}
checks.push(["content not normalization-stable", unstable, 0]);

check.close();

console.log("\n=== validation ===");
let failed = 0;
for (const [label, actual, expected] of checks) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(
    `  ${ok ? "ok  " : "FAIL"}  ${label.padEnd(36)} ${actual} (expected ${expected})`,
  );
}

if (failed > 0) {
  console.error(`\n${failed} validation check(s) failed.`);
  process.exit(1);
}

console.log(`\nWrote ${spaceDbPath}`);
console.log(
  "Restart the server to pick the space up: reconcileLocalSpaceIndex scans " +
    "data/spaces/*.db, so auth.db needs no manual edit.",
);
