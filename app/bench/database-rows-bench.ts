#!/usr/bin/env bun
/**
 * Benchmarks the document functions a "database" (a parent document holding
 * `record`-type rows) drives: row creation, listing, content edits and
 * property patches — at the row count where `generateUniqueSlug`'s
 * space-wide, unindexed slug search used to turn every write in the space
 * into an O(n) scan (see `#db/space/documents.ts`).
 *
 * Two "database" documents are seeded in one space. Database A is filled with
 * `--rows` untitled records — the case that collides on the shared
 * "untitled" slug — while database B stays empty. Creating one row in B after
 * A is full is the exact regression report: a write to an unrelated database
 * in the same space hanging behind A's slug collisions. Row-creation latency
 * into A is sampled every `--sample-every` rows so a reintroduced O(n) scan
 * shows up as a rising trend, not just a slow final number.
 *
 * Run from `app/` (writes straight through the DB layer, like seed-space.ts):
 *   bun bench/database-rows-bench.ts                  # 5000 rows → bench/data
 *   bun bench/database-rows-bench.ts --rows 20000
 *   bun bench/database-rows-bench.ts --memory          # RAM-only, nothing persists
 *
 * To see the pre-fix O(n²) curve for comparison, check out the commit before
 * the `generateUniqueSlug` rewrite and rerun the same command.
 *
 * Flags:
 *   --rows <n>          untitled records to create in database A (default 5000)
 *   --sample-every <n>  print a progress line every n rows (default 500)
 *   --dir <path>        working directory holding ./data (default bench)
 *   --memory            keep the database in RAM (implies no persistence)
 *   --reset             delete the auth db and spaces under <dir>/data first
 *   --seed <n>          PRNG seed for content (default 1)
 */

import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";

function parseOptions(args: string[]) {
  const flag = (name: string) => args.includes(`--${name}`);
  const opt = (name: string, fallback: string): string => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const int = (name: string, fallback: number) =>
    Number.parseInt(opt(name, String(fallback)), 10);

  return {
    rows: int("rows", 5000),
    sampleEvery: int("sample-every", 500),
    dir: opt("dir", "bench"),
    inMemory: flag("memory"),
    reset: flag("reset"),
    seed: int("seed", 1),
  };
}

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

function percentile(sorted: number[], p: number): number {
  const i = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

function stats(times: number[]) {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    avg: sum / sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1],
  };
}

function printStats(label: string, times: number[]): void {
  const s = stats(times);
  console.log(
    `  ${label.padEnd(38)} avg=${s.avg.toFixed(2)}ms  p50=${s.p50.toFixed(2)}ms  ` +
      `p95=${s.p95.toFixed(2)}ms  p99=${s.p99.toFixed(2)}ms  max=${s.max.toFixed(2)}ms  (n=${s.count})`,
  );
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const rng = createRng(options.seed);

  const appDir = path.resolve(import.meta.dir, "..");
  const workingDir = path.resolve(appDir, options.dir);
  const dataDir = path.join(workingDir, "data");

  if (options.inMemory) {
    process.env.VEKTOR_IN_MEMORY_DB = "1";
  } else {
    if (options.reset) {
      for (const target of ["auth.db", "auth.db-wal", "auth.db-shm", "spaces"]) {
        rmSync(path.join(dataDir, target), { recursive: true, force: true });
      }
      console.log(`Reset:   cleared databases under ${dataDir}`);
    }
    mkdirSync(workingDir, { recursive: true });
    process.chdir(workingDir);
  }
  process.env.VEKTOR_NO_AUTH = "1";

  // The DB layer resolves its data directory and environment on first import,
  // so nothing under #db/ can be imported until chdir/env above have run.
  const { LOCAL_USER, LOCAL_USER_ID } = await import("#config");
  const { initializeDatabases, getAuthDb } = await import("#db/client/db.ts");
  const { openSpaceStore } = await import("#db/client/store.ts");
  const { createSpace } = await import("#db/space/spaces.ts");
  const { createDocument, getDocumentChildren, updateDocument } = await import(
    "#db/space/documents.ts"
  );
  const { patchDocumentProperties } = await import("#db/space/properties.ts");
  const authSchema = await import("#db/schema/auth.ts");

  await initializeDatabases();
  await getAuthDb()
    .insert(authSchema.user)
    .values({ ...LOCAL_USER, groups: null })
    .onConflictDoNothing();

  const slug = `db-rows-bench-${Date.now()}`;
  const created = await createSpace(LOCAL_USER_ID, "Database Rows Bench", slug);
  const store = await openSpaceStore(created.id);
  console.log(`Space:   ${created.id} (/${created.slug})`);

  const databaseA = await createDocument(store, LOCAL_USER_ID, "database-a", "", {
    type: "database",
    properties: { title: "Database A" },
  });
  const databaseB = await createDocument(store, LOCAL_USER_ID, "database-b", "", {
    type: "database",
    properties: { title: "Database B" },
  });
  console.log(`Database A: ${databaseA.id}   Database B: ${databaseB.id}\n`);

  // --- row creation, database A --------------------------------------------
  // Every row is untitled, exactly the case that collides on the shared
  // "untitled" slug: no title/slug is passed, matching what the create-
  // document API does when the client sends no title (see routes/spaces/
  // documents.ts, `slugBase = slugHint || ... || "untitled"`).
  console.log(`── Creating ${options.rows} untitled records in database A ──`);
  const rowIds: string[] = [];
  const createBatch: number[] = [];
  let batchStart = Date.now();
  const startedAt = Date.now();

  for (let i = 0; i < options.rows; i++) {
    const t0 = performance.now();
    const row = await createDocument(store, LOCAL_USER_ID, "untitled", "<p></p>", {
      parentId: databaseA.id,
      type: "record",
    });
    createBatch.push(performance.now() - t0);
    rowIds.push(row.id);

    if ((i + 1) % options.sampleEvery === 0 || i === options.rows - 1) {
      const batchMs = Date.now() - batchStart;
      const s = stats(createBatch);
      console.log(
        `  ${String(i + 1).padStart(6)}/${options.rows}  ` +
          `last ${createBatch.length} rows: avg=${s.avg.toFixed(2)}ms p99=${s.p99.toFixed(2)}ms max=${s.max.toFixed(2)}ms` +
          `  (${(createBatch.length / (batchMs / 1000)).toFixed(0)} rows/s)`,
      );
      createBatch.length = 0;
      batchStart = Date.now();
    }
  }
  console.log(
    `Done: ${options.rows} rows in database A in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
  );

  // --- the regression case: create a row in the OTHER database -------------
  console.log("── Creating one row in database B (the regression case) ──");
  const crossTimes: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await createDocument(store, LOCAL_USER_ID, "untitled", "<p></p>", {
      parentId: databaseB.id,
      type: "record",
    });
    crossTimes.push(performance.now() - t0);
  }
  printStats("Create row in B (A has these rows)", crossTimes);
  console.log();

  // --- listing ---------------------------------------------------------------
  console.log("── Listing database A's rows ──");
  const firstPageTimes: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    await getDocumentChildren(store, databaseA.id, null, { limit: 50 });
    firstPageTimes.push(performance.now() - t0);
  }
  printStats("GET children (first page, 50)", firstPageTimes);

  // Walk to a deep cursor so the second measurement is a keyset seek at
  // depth, not just the first page every time.
  let deepCursor: string | undefined;
  let cursor: string | undefined;
  for (let i = 0; i < 50 && (i === 0 || cursor); i++) {
    const page = await getDocumentChildren(store, databaseA.id, null, {
      limit: 50,
      cursor,
    });
    cursor = page.nextCursor ?? undefined;
    if (!cursor) break;
    deepCursor = cursor;
  }
  const deepPageTimes: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    await getDocumentChildren(store, databaseA.id, null, {
      limit: 50,
      cursor: deepCursor,
    });
    deepPageTimes.push(performance.now() - t0);
  }
  printStats("GET children (cursor, depth ~2500, 50)", deepPageTimes);
  console.log();

  // --- modification (content) -------------------------------------------------
  console.log("── Modifying rows (content + properties) ──");
  const pick = (items: readonly string[]) => items[Math.floor(rng() * items.length)];
  const contentTimes: number[] = [];
  for (let i = 0; i < 200; i++) {
    const id = pick(rowIds);
    const t0 = performance.now();
    await updateDocument(store, id, `<p>Edited ${i}</p>`);
    contentTimes.push(performance.now() - t0);
  }
  printStats("PUT content (new revision)", contentTimes);

  const STATUSES = ["draft", "review", "approved", "published"] as const;
  const propertyTimes: number[] = [];
  for (let i = 0; i < 200; i++) {
    const id = pick(rowIds);
    const t0 = performance.now();
    await patchDocumentProperties(store, id, { status: pick(STATUSES) }, LOCAL_USER_ID);
    propertyTimes.push(performance.now() - t0);
  }
  printStats("PATCH properties", propertyTimes);

  console.log(`\nSpace id: ${created.id}${options.inMemory ? " (in-memory, not persisted)" : ""}`);
}

if (import.meta.main) {
  await main();
}
