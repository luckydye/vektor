#!/usr/bin/env bun
/**
 * Builds a large space database for load, perf and UI-at-scale work:
 * tens of thousands of documents, a long-tailed revision history (a handful of
 * documents reach `--max-revisions`), and hundreds of members.
 *
 * Rows are written straight through the DB layer rather than the HTTP API.
 * `createDocument` rescans every slug in the space per document and embeds each
 * body, and `createRevision` reads the previous revision and writes an audit
 * entry — minutes of work per thousand documents. The bulk inserts here
 * produce the same rows in the same shape.
 *
 * Run from `app/`:
 *   bun bench/seed-space.ts                             # 30k docs, 300 members → bench/data
 *   bun bench/seed-space.ts --docs 50000 --members 500
 *   bun bench/seed-space.ts --memory --no-auth          # RAM-only, served (nothing persists)
 *   bun bench/seed-space.ts --serve --no-auth --port 7500
 *
 * Flags:
 *   --docs <n>           documents to create (default 30000)
 *   --members <n>        space members, one auth user each (default 300)
 *   --max-revisions <n>  revisions of the busiest document (default 1000)
 *   --memory             keep every database in RAM; implies --serve because
 *                        the data dies with this process
 *   --fs                 file-backed SQLite under <dir>/data (default)
 *   --dir <path>         working directory holding ./data (default bench)
 *   --no-auth            seed as, and serve without auth for, the local super-user
 *   --serve              start the server on the seeded data when seeding is done
 *   --port <n>           port for --serve (default 8080, parsed by src/server.ts)
 *   --api-only           serve the API without the Astro frontend (auto-enabled
 *                        when there is no client build to serve)
 *   --reset              delete the auth db, spaces and uploads under <dir>/data first
 *   --name <name>        space name (default "Bench Space")
 *   --slug <slug>        space slug (default "bench")
 *   --seed <n>           PRNG seed (default 1) — same seed, same database
 *   --quality <0-11>     brotli quality for revision snapshots (default 4). Only
 *                        trades seed time against file size; any level reads back.
 *   --no-audit           skip the audit trail (one row per document creation,
 *                        revision, publish and grant — the largest table by row
 *                        count after `revision`)
 */

import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { SpaceDb } from "#db/client/store.ts";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface SeedOptions {
  docs: number;
  members: number;
  maxRevisions: number;
  name: string;
  slug: string;
  seed: number;
  quality: number;
  audit: boolean;
}

interface CliOptions extends SeedOptions {
  dir: string;
  inMemory: boolean;
  serve: boolean;
  apiOnly: boolean;
  reset: boolean;
  noAuth: boolean;
}

export interface SeedResult {
  spaceId: string;
  slug: string;
  documents: number;
  revisions: number;
  properties: number;
  auditEntries: number;
  members: number;
  elapsedMs: number;
}

function parseOptions(args: string[]): CliOptions {
  const flag = (name: string) => args.includes(`--${name}`);
  const opt = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const int = (name: string, fallback: number) =>
    Number.parseInt(opt(name, String(fallback)), 10);

  const inMemory = flag("memory");

  return {
    docs: int("docs", 30_000),
    members: int("members", 300),
    maxRevisions: int("max-revisions", 1000),
    name: opt("name", "Bench Space"),
    slug: opt("slug", "bench"),
    seed: int("seed", 1),
    quality: int("quality", 4),
    audit: !flag("no-audit"),
    inMemory,
    dir: opt("dir", "bench"),
    // An in-memory database exists only inside this process, so seeding it and
    // exiting would produce nothing at all.
    serve: flag("serve") || inMemory,
    apiOnly: flag("api-only"),
    reset: flag("reset"),
    noAuth: flag("no-auth"),
  };
}

// ---------------------------------------------------------------------------
// Deterministic content generation
// ---------------------------------------------------------------------------
/** mulberry32 — small, fast, and identical across runs for a given seed. */
function createRng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEPARTMENTS = [
  "Engineering",
  "Product",
  "Design",
  "Operations",
  "Security",
  "Data",
  "Infrastructure",
  "Mobile",
  "Frontend",
  "Backend",
];

const SECTIONS = [
  "Architecture",
  "Runbooks",
  "RFCs",
  "Onboarding",
  "Guides",
  "API Reference",
  "Policies",
  "Decisions",
  "Meeting Notes",
  "Retrospectives",
];

const CATEGORIES = [
  { name: "Handbook", color: "#4ECDC4", icon: "book" },
  { name: "Engineering", color: "#5B8DEF", icon: "code" },
  { name: "Operations", color: "#F6AD55", icon: "activity" },
  { name: "Product", color: "#B794F4", icon: "compass" },
  { name: "Security", color: "#FC8181", icon: "shield" },
  { name: "Archive", color: "#A0AEC0", icon: "archive" },
];

const GROUPS = ["engineering", "product", "design", "operations", "security", "data"];

const STATUSES = ["draft", "review", "approved", "published", "deprecated"];
const PRIORITIES = ["p0", "p1", "p2", "p3"];

const FIRST_NAMES = [
  "Ada",
  "Bo",
  "Cleo",
  "Dev",
  "Emil",
  "Fay",
  "Gus",
  "Hana",
  "Ines",
  "Jo",
  "Kai",
  "Lena",
  "Milo",
  "Nora",
  "Otis",
  "Pia",
  "Quinn",
  "Rune",
  "Sena",
  "Tomas",
  "Uma",
  "Vik",
  "Wren",
  "Xan",
  "Yara",
  "Zev",
];

const LAST_NAMES = [
  "Adler",
  "Brandt",
  "Corvi",
  "Dahl",
  "Engel",
  "Frei",
  "Gruber",
  "Haas",
  "Iversen",
  "Jung",
  "Keller",
  "Lund",
  "Maier",
  "Novak",
  "Ortiz",
  "Pahl",
  "Reuter",
  "Sauer",
  "Thiel",
  "Urban",
  "Vogt",
  "Wirth",
  "Zeller",
];

const SENTENCES = [
  "This document describes the system architecture and deployment topology.",
  "All engineers are expected to review this runbook before handling incidents.",
  "The API follows RESTful conventions with JSON request and response bodies.",
  "Security review is required before any change is merged to the main branch.",
  "Performance benchmarks should be run after every major release.",
  "Monitoring dashboards are available under the team namespace.",
  "Database migrations must be backwards compatible and support zero-downtime deploys.",
  "Service dependencies are documented in the adjacent architecture diagram.",
  "All configuration is managed via environment variables; no secrets in source.",
  "The on-call rotation is published in the scheduler and rotates weekly.",
  "Rate limiting applies to all public endpoints at 1000 requests per minute.",
  "Caching headers are set so that stale responses never reach production clients.",
  "The feature flag system allows a gradual rollout without a code deploy.",
  "Integration tests run in CI against a real database instance.",
  "Documentation is updated in the same change as the code it describes.",
  "The search index is rebuilt nightly; a manual rebuild is available via the API.",
  "User data is encrypted at rest with AES-256 and in transit with TLS 1.3.",
  "Access control is enforced at the API layer; the frontend mirrors these checks.",
  "Audit logs capture every write with actor, resource and timestamp.",
  "SLO targets: 99.9% availability, p99 latency below 200ms, error rate below 0.1%.",
];

const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)];

const intBetween = (rng: () => number, min: number, max: number): number =>
  Math.floor(rng() * (max - min + 1)) + min;

function generateHtml(rng: () => number, title: string, paragraphs: number): string {
  const blocks: string[] = [`<h1>${title}</h1>`];
  for (let i = 0; i < paragraphs; i++) {
    if (i % 2 === 0) blocks.push(`<h2>Section ${i + 1}</h2>`);
    const sentences = Array.from({ length: intBetween(rng, 3, 8) }, () =>
      pick(rng, SENTENCES),
    );
    blocks.push(`<p>${sentences.join(" ")}</p>`);
  }
  if (rng() > 0.6) {
    blocks.push(
      `<pre><code>GET /api/v1/spaces/{spaceId}/documents\nAuthorization: Bearer &lt;token&gt;\n\n# Response\n{ "documents": [...], "total": ${intBetween(rng, 1, 9999)} }</code></pre>`,
    );
  }
  if (rng() > 0.7) {
    const rows = Array.from(
      { length: intBetween(rng, 2, 6) },
      (_, i) =>
        `<tr><td>${pick(rng, SECTIONS)}</td><td>${pick(rng, STATUSES)}</td><td>${i}</td></tr>`,
    ).join("");
    blocks.push(`<table><tbody>${rows}</tbody></table>`);
  }
  return blocks.join("");
}

/**
 * How many revisions a document carries.
 *
 * Real spaces are long-tailed: most documents are saved a handful of times and
 * a few live documents accumulate hundreds. A uniform distribution would make
 * both the average and the worst case wrong.
 */
function revisionCount(rng: () => number, maxRevisions: number): number {
  const roll = rng();
  const clamp = (value: number) => Math.max(1, Math.min(maxRevisions, value));
  if (roll < 0.65) return clamp(intBetween(rng, 1, 3));
  if (roll < 0.9) return clamp(intBetween(rng, 4, 10));
  if (roll < 0.98) return clamp(intBetween(rng, 11, 40));
  if (roll < 0.995) return clamp(intBetween(rng, 41, 150));
  return clamp(intBetween(rng, Math.floor(maxRevisions / 2), maxRevisions));
}

// ---------------------------------------------------------------------------
// Bulk write helpers
// ---------------------------------------------------------------------------
/**
 * Rows per INSERT. SQLite binds one parameter per column per row and rejects a
 * statement past ~32k of them, so the widest table sets the ceiling.
 */
const ROWS_PER_INSERT = 400;

async function insertChunked<Table extends SQLiteTable>(
  db: SpaceDb,
  table: Table,
  rows: Table["$inferInsert"][],
  rowsPerInsert = ROWS_PER_INSERT,
): Promise<void> {
  for (let i = 0; i < rows.length; i += rowsPerInsert) {
    await db
      .insert(table)
      .values(rows.slice(i, i + rowsPerInsert))
      .onConflictDoNothing();
  }
}

/** Brotli runs on libuv's threadpool, so revision snapshots compress in parallel. */
async function mapWithConcurrency<Item, Result>(
  items: Item[],
  limit: number,
  fn: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index], index);
      }
    }),
  );
  return results;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 90) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
/**
 * The database modules resolve their data directory and their environment when
 * they are first imported, so they must not be imported until the CLI has
 * chdir'd and set `VEKTOR_*`. Hence the dynamic imports.
 */
export async function seedSpace(options: SeedOptions): Promise<SeedResult> {
  const { promisify } = await import("node:util");
  const { brotliCompress, constants: zlibConstants } = await import("node:zlib");
  const { createHash } = await import("node:crypto");
  const { eq } = await import("drizzle-orm");
  const { LOCAL_USER, LOCAL_USER_ID, isNoAuthMode } = await import("#config");
  const { Permission, ResourceType } = await import("#acl/permissions.ts");
  const { getAuthDb, initializeDatabases } = await import("#db/client/db.ts");
  const { openSpaceStore } = await import("#db/client/store.ts");
  const { createSpace } = await import("#db/space/spaces.ts");
  const { createId } = await import("#db/ids.ts");
  const { buildDocumentSearchText } = await import("#search/embedding.ts");
  const { slugify } = await import("#utils/slug.ts");
  const authSchema = await import("#db/schema/auth.ts");
  const space = await import("#db/schema/space.ts");

  const compress = promisify(brotliCompress);
  const compressHtml = async (html: string): Promise<Buffer> => {
    const buffer = Buffer.from(html, "utf-8");
    return (await compress(buffer, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: options.quality,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: buffer.byteLength,
      },
    })) as Buffer;
  };
  const checksum = (html: string) =>
    createHash("sha256").update(html, "utf-8").digest("hex");

  const rng = createRng(options.seed);
  const startedAt = Date.now();
  // Content is dated backwards from a fixed "now" so listings and history
  // spread over two years instead of piling onto one timestamp.
  const now = new Date();
  const HISTORY_MS = 2 * 365 * 24 * 60 * 60 * 1000;

  await initializeDatabases();
  const authDb = getAuthDb();

  // --- members -------------------------------------------------------------
  // Ids and emails are namespaced by slug so seeding a second space into the
  // same auth database does not collide on the unique email index.
  const memberIdPrefix = `${slugify(options.slug)}_member`;
  const members = Array.from({ length: options.members }, (_, i) => {
    const name = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    // A third of the members reach the space through a group grant instead of
    // a direct one, which is the case ACL resolution is slowest on.
    const groups = rng() < 0.35 ? [pick(rng, GROUPS)] : [];
    const createdAt = new Date(now.getTime() - Math.floor(rng() * HISTORY_MS));
    return {
      id: `${memberIdPrefix}_${i}`,
      name,
      email: `${memberIdPrefix}-${i}@bench.local`,
      emailVerified: true,
      image: null,
      groups: groups.length > 0 ? JSON.stringify(groups) : null,
      createdAt,
      updatedAt: createdAt,
      /** Not persisted — drives the ACL rows below. */
      groupNames: groups,
    };
  });

  await insertChunked(
    authDb,
    authSchema.user,
    members.map(({ groupNames: _groupNames, ...row }) => row),
  );

  const noAuth = isNoAuthMode();
  if (noAuth) {
    // The members table resolves display names from the auth database, so the
    // super-user needs a row there to show up as the owner.
    await insertChunked(authDb, authSchema.user, [{ ...LOCAL_USER, groups: null }]);
  }
  const ownerId = noAuth ? LOCAL_USER_ID : (members[0]?.id ?? "bench_owner");
  const authorIds = members.length > 0 ? members.map((member) => member.id) : [ownerId];

  console.log(`Members: ${members.length} (owner: ${ownerId})`);

  // --- space ---------------------------------------------------------------
  const created = await createSpace(ownerId, options.name, options.slug);
  const spaceId = created.id;
  const { db } = await openSpaceStore(spaceId);
  console.log(`Space:   ${spaceId} (/${created.slug})`);

  // --- categories ----------------------------------------------------------
  const categories = CATEGORIES.map((entry, order) => ({
    id: createId("category"),
    name: entry.name,
    slug: slugify(entry.name),
    description: `${entry.name} documents`,
    color: entry.color,
    icon: entry.icon,
    order,
    createdAt: now,
    updatedAt: now,
  }));
  await insertChunked(db, space.category, categories);

  // --- documents, properties, revisions ------------------------------------
  type DocRow = typeof space.document.$inferInsert;
  type PropRow = typeof space.property.$inferInsert;
  type RevRow = typeof space.revision.$inferInsert;
  type AuditRow = typeof space.auditLog.$inferInsert;

  let documentsWritten = 0;
  let revisionsWritten = 0;
  let propertiesWritten = 0;
  let auditWritten = 0;
  let lastReport = Date.now();

  interface DocPlan {
    title: string;
    slug: string;
    parentId: string | null;
    category: string | null;
    department: string;
    section: string;
    /** Forces the extreme of the revision distribution onto one document. */
    busiest?: boolean;
  }

  /** Builds and writes one batch of documents with their properties and history. */
  async function writeDocuments(plans: DocPlan[]): Promise<string[]> {
    const docRows: DocRow[] = [];
    const propRows: PropRow[] = [];
    const auditRows: AuditRow[] = [];
    const ids: string[] = [];

    interface RevisionPlan {
      documentId: string;
      slug: string;
      rev: number;
      html: string;
      status: "open" | null;
      parentRev: number | null;
      createdAt: Date;
      createdBy: string;
    }
    const revisionPlans: RevisionPlan[] = [];

    for (const plan of plans) {
      const id = createId("document");
      ids.push(id);

      const createdAt = new Date(now.getTime() - Math.floor(rng() * HISTORY_MS));
      const updatedAt = new Date(
        createdAt.getTime() + Math.floor(rng() * (now.getTime() - createdAt.getTime())),
      );
      const createdBy = pick(rng, authorIds);
      const content = generateHtml(rng, plan.title, intBetween(rng, 2, 7));
      const revisions = plan.busiest
        ? options.maxRevisions
        : revisionCount(rng, options.maxRevisions);

      const properties: Record<string, string> = {
        title: plan.title,
        status: pick(rng, STATUSES),
        priority: pick(rng, PRIORITIES),
        owner: pick(rng, authorIds),
        department: plan.department,
        section: plan.section,
        version: `${intBetween(rng, 1, 5)}.${intBetween(rng, 0, 9)}.${intBetween(rng, 0, 9)}`,
        reviewed: rng() > 0.5 ? "true" : "false",
      };
      if (plan.category) properties.category = plan.category;

      for (const [key, value] of Object.entries(properties)) {
        propRows.push({
          id: createId("property"),
          documentId: id,
          key,
          value,
          type: null,
          createdAt,
          updatedAt,
        });
      }

      // Published a while ago, published at head, or never published.
      const publishRoll = rng();
      const publishedRev =
        publishRoll < 0.15
          ? null
          : publishRoll < 0.4
            ? Math.max(1, revisions - intBetween(rng, 1, Math.min(5, revisions)))
            : revisions;

      docRows.push({
        id,
        slug: plan.slug,
        type: null,
        archived: rng() < 0.02,
        readonly: false,
        content,
        searchText: buildDocumentSearchText(content, properties),
        searchEmbedding: null,
        searchEmbeddingModel: null,
        searchUpdatedAt: updatedAt,
        currentRev: revisions,
        publishedRev,
        parentId: plan.parentId,
        createdAt,
        updatedAt,
        createdBy,
      });

      if (options.audit) {
        auditRows.push({
          docId: id,
          userId: createdBy,
          event: "create",
          details: JSON.stringify({ message: "Document created" }),
          createdAt,
        });
      }

      // Revision bodies march from the document's creation to its last update;
      // the head revision holds exactly the document's current content.
      const span = Math.max(1, updatedAt.getTime() - createdAt.getTime());
      for (let rev = 1; rev <= revisions; rev++) {
        const revisionAt = new Date(
          createdAt.getTime() + Math.floor((span * rev) / revisions),
        );
        const revisionBy = pick(rng, authorIds);
        revisionPlans.push({
          documentId: id,
          slug: plan.slug,
          rev,
          html:
            rev === revisions
              ? content
              : generateHtml(rng, plan.title, intBetween(rng, 2, 7)),
          status: null,
          parentRev: rev === 1 ? null : rev - 1,
          createdAt: revisionAt,
          createdBy: revisionBy,
        });

        if (!options.audit) continue;
        auditRows.push({
          docId: id,
          revisionId: rev,
          userId: revisionBy,
          event: "save",
          details: JSON.stringify({
            message: "Revision created",
            parentRev: rev === 1 ? null : rev - 1,
            status: null,
          }),
          createdAt: revisionAt,
        });
        if (rev === publishedRev) {
          auditRows.push({
            docId: id,
            revisionId: rev,
            userId: revisionBy,
            event: "publish",
            details: JSON.stringify({ message: `Published revision ${rev}` }),
            createdAt: revisionAt,
          });
        }
      }

      // Open suggestions sit past the head revision without moving currentRev,
      // exactly as createRevision leaves them.
      if (rng() < 0.03) {
        const suggestions = intBetween(rng, 1, 2);
        for (let i = 1; i <= suggestions; i++) {
          const suggestionBy = pick(rng, authorIds);
          revisionPlans.push({
            documentId: id,
            slug: plan.slug,
            rev: revisions + i,
            html: generateHtml(rng, `${plan.title} (suggestion ${i})`, 2),
            status: "open",
            parentRev: revisions,
            createdAt: updatedAt,
            createdBy: suggestionBy,
          });

          if (!options.audit) continue;
          auditRows.push({
            docId: id,
            revisionId: revisions + i,
            userId: suggestionBy,
            event: "suggest",
            details: JSON.stringify({
              message: "Suggestion created",
              parentRev: revisions,
              status: "open",
            }),
            createdAt: updatedAt,
          });
        }
      }
    }

    const revRows: RevRow[] = await mapWithConcurrency(
      revisionPlans,
      navigator.hardwareConcurrency ?? 8,
      async (plan) => ({
        id: createId("revision"),
        documentId: plan.documentId,
        rev: plan.rev,
        slug: plan.slug,
        snapshot: await compressHtml(plan.html),
        checksum: checksum(plan.html),
        parentRev: plan.parentRev,
        status: plan.status,
        message: plan.status === "open" ? "Suggested edit" : null,
        createdAt: plan.createdAt,
        createdBy: plan.createdBy,
      }),
    );

    await insertChunked(db, space.document, docRows);
    await insertChunked(db, space.property, propRows);
    // Snapshots are blobs; fewer rows per statement keeps each one small.
    await insertChunked(db, space.revision, revRows, 100);
    await insertChunked(db, space.auditLog, auditRows);

    documentsWritten += docRows.length;
    propertiesWritten += propRows.length;
    revisionsWritten += revRows.length;
    auditWritten += auditRows.length;

    if (Date.now() - lastReport > 2000) {
      const elapsed = Date.now() - startedAt;
      const remaining = options.docs - documentsWritten;
      const eta = (elapsed / Math.max(1, documentsWritten)) * remaining;
      console.log(
        `  ${documentsWritten}/${options.docs} documents, ${revisionsWritten} revisions` +
          ` — ${formatDuration(elapsed)} elapsed, ~${formatDuration(eta)} left`,
      );
      lastReport = Date.now();
    }

    return ids;
  }

  // Department roots carry the category; sections and leaves inherit it through
  // the tree, which is how the app resolves category membership.
  const departmentPlans: DocPlan[] = DEPARTMENTS.map((department, i) => ({
    title: `${department} Overview`,
    slug: slugify(`${department}-overview`),
    parentId: null,
    category: categories[i % categories.length].slug,
    department,
    section: "Overview",
  }));
  const departmentIds = await writeDocuments(departmentPlans);

  const sectionPlans: DocPlan[] = [];
  for (const [i, department] of DEPARTMENTS.entries()) {
    for (const section of SECTIONS) {
      sectionPlans.push({
        title: `${department} ${section}`,
        slug: slugify(`${department}-${section}`),
        parentId: departmentIds[i],
        category: null,
        department,
        section,
      });
    }
  }
  const sectionIds = await writeDocuments(sectionPlans);

  const leafCount = Math.max(0, options.docs - departmentIds.length - sectionIds.length);
  const DOCS_PER_BATCH = 250;
  for (let start = 0; start < leafCount; start += DOCS_PER_BATCH) {
    const batch: DocPlan[] = [];
    for (let i = start; i < Math.min(start + DOCS_PER_BATCH, leafCount); i++) {
      const sectionIndex = i % sectionIds.length;
      const department = DEPARTMENTS[Math.floor(sectionIndex / SECTIONS.length)];
      const section = SECTIONS[sectionIndex % SECTIONS.length];
      // The index in the title keeps the slug unique without the per-document
      // slug scan `createDocument` does.
      const title = `${department} ${section} ${i}`;
      batch.push({
        title,
        slug: slugify(title),
        parentId: sectionIds[sectionIndex],
        category: null,
        department,
        section,
        busiest: i === 0,
      });
    }
    await writeDocuments(batch);
  }

  // --- access control ------------------------------------------------------
  type AclRow = typeof space.acl.$inferInsert;
  const aclRows: AclRow[] = [];
  const grantedAt = { createdAt: now, updatedAt: now };

  for (const member of members) {
    if (member.id === ownerId) continue;
    // Group members get their access through the group grant below.
    if (member.groupNames.length > 0) continue;
    const roll = rng();
    aclRows.push({
      resourceType: ResourceType.SPACE,
      resourceId: spaceId,
      userId: member.id,
      groupId: null,
      permission:
        roll < 0.05
          ? Permission.OWNER
          : roll < 0.5
            ? Permission.EDITOR
            : Permission.VIEWER,
      ...grantedAt,
    });
  }

  for (const group of GROUPS) {
    aclRows.push({
      resourceType: ResourceType.SPACE,
      resourceId: spaceId,
      userId: null,
      groupId: group,
      permission: rng() < 0.5 ? Permission.EDITOR : Permission.VIEWER,
      ...grantedAt,
    });
  }

  // A slice of members holds only a document-scoped grant. Those are the rows
  // that make listing and search filter per document instead of per space.
  const scopedGrantees = members.filter(() => rng() < 0.05);
  for (const member of scopedGrantees) {
    aclRows.push({
      resourceType: rng() < 0.5 ? ResourceType.DOCUMENT : ResourceType.DOCUMENT_TREE,
      resourceId: pick(rng, sectionIds),
      userId: member.id,
      groupId: null,
      permission: rng() < 0.5 ? Permission.EDITOR : Permission.VIEWER,
      ...grantedAt,
    });
  }

  await insertChunked(db, space.acl, aclRows);

  if (options.audit) {
    // Mirrors logAclChange: space-wide grants are logged against the space,
    // document-scoped ones against the document they apply to.
    const memberNames = new Map(members.map((member) => [member.id, member.name]));
    await insertChunked(
      db,
      space.auditLog,
      aclRows.map((row) => {
        const documentScoped =
          row.resourceType === ResourceType.DOCUMENT ||
          row.resourceType === ResourceType.DOCUMENT_TREE;
        const targetName = row.userId ? memberNames.get(row.userId) : undefined;
        const target = row.userId
          ? `user ${targetName ?? row.userId}`
          : `group ${row.groupId}`;
        const scope =
          row.resourceType === ResourceType.SPACE
            ? "the space"
            : `${row.resourceType} ${row.resourceId}`;
        return {
          docId: documentScoped ? row.resourceId : spaceId,
          userId: ownerId,
          event: "acl_grant",
          details: JSON.stringify({
            message: `Granted ${row.permission} permission on ${scope} to ${target}`,
            permission: row.permission,
            targetUserId: row.userId ?? undefined,
            targetGroupId: row.groupId ?? undefined,
            targetName,
            resourceType: row.resourceType,
            resourceId: row.resourceId,
          }),
          createdAt: now,
        };
      }),
    );
    auditWritten += aclRows.length;
  }

  console.log(
    `ACL:     ${aclRows.length} grants (${GROUPS.length} group, ${scopedGrantees.length} document-scoped)`,
  );

  // The space metadata timestamp should reflect the seeded history, not the
  // moment createSpace ran.
  await db
    .update(space.spaceMetadata)
    .set({ updatedAt: now })
    .where(eq(space.spaceMetadata.id, spaceId));

  return {
    spaceId,
    slug: created.slug,
    documents: documentsWritten,
    revisions: revisionsWritten,
    properties: propertiesWritten,
    auditEntries: auditWritten,
    members: members.length,
    elapsedMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const appDir = path.resolve(import.meta.dir, "..");
  const workingDir = path.resolve(appDir, options.dir);
  const dataDir = path.join(workingDir, "data");

  if (options.inMemory) {
    process.env.VEKTOR_IN_MEMORY_DB = "1";
  } else {
    if (options.reset) {
      // Only the generated artefacts — the directory also holds tracked files
      // such as bench/data/baseline.json.
      for (const target of [
        "auth.db",
        "auth.db-wal",
        "auth.db-shm",
        "spaces",
        "uploads",
      ]) {
        rmSync(path.join(dataDir, target), { recursive: true, force: true });
      }
      console.log(`Reset:   cleared databases under ${dataDir}`);
    }

    // The DB layer resolves ./data against the process directory, so this must
    // happen before any of it is imported.
    mkdirSync(workingDir, { recursive: true });
    process.chdir(workingDir);
  }

  if (options.noAuth) process.env.VEKTOR_NO_AUTH = "1";

  console.log(
    `Seeding ${options.docs} documents, ${options.members} members,` +
      ` up to ${options.maxRevisions} revisions per document` +
      ` (${options.inMemory ? "in-memory" : dataDir}${options.noAuth ? ", no-auth" : ""})`,
  );

  const result = await seedSpace(options);

  console.log(
    `\nDone in ${formatDuration(result.elapsedMs)}: ${result.documents} documents,` +
      ` ${result.revisions} revisions, ${result.properties} properties,` +
      ` ${result.auditEntries} audit entries, ${result.members} members.`,
  );
  console.log(`Space id: ${result.spaceId}`);

  if (!options.inMemory) {
    const dbFile = path.join(dataDir, "spaces", `${result.spaceId}.db`);
    const bytes = statSync(dbFile).size;
    console.log(`Database: ${dbFile} (${(bytes / 1024 ** 2).toFixed(0)} MB)`);
  }

  if (!options.serve) {
    // Serving happens from the seeded working directory, because that is where
    // the server looks for ./data.
    const env = options.noAuth ? "VEKTOR_NO_AUTH=1 " : "";
    const relative = path.relative(appDir, workingDir);
    const target = relative.startsWith("..") ? workingDir : relative || ".";
    console.log(
      `\nServe this database with:\n` +
        `  (cd ${target} && ${env}bun ${path.join(appDir, "src", "server.ts")} --port 8080)`,
    );
    return;
  }

  if (options.inMemory) {
    console.log("In-memory: the database lives only as long as this process.");
  }

  // Without a client build there is nothing to serve the frontend from, and the
  // Astro entry throws on import — run headless instead of failing after a
  // multi-minute seed.
  const hasClientBuild = existsSync(path.join(appDir, "dist", "server", "entry.mjs"));
  if (options.apiOnly || !hasClientBuild) {
    if (!options.apiOnly) {
      console.log("No client build found (dist/server) — serving the API only.");
    }
    process.env.VEKTOR_API_ONLY = "1";
  }

  // src/server.ts starts listening on import and reads --port from process.argv.
  // The path is built rather than written literally because the process has
  // chdir'd into the data directory, and a relative parent import is banned.
  await import(path.join(appDir, "src", "server.ts"));
}

if (import.meta.main) {
  await main();
}
