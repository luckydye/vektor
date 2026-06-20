#!/usr/bin/env bun
/**
 * Performance benchmark harness for Vektor.
 *
 * Launches the release binary against a persistent on-disk SQLite database,
 * seeds ~10 000 documents with revisions / comments / properties, then runs
 * a comprehensive latency benchmark and compares the result with a saved
 * baseline.
 *
 * Usage:
 *   bun bench/perf.ts                # seed (if needed) + bench
 *   bun bench/perf.ts --seed-only    # only create data, skip benchmarks
 *   bun bench/perf.ts --bench-only   # skip seeding, assume DB already exists
 *   bun bench/perf.ts --reset        # delete existing DB, reseed, then bench
 *   bun bench/perf.ts --docs 5000    # override document count
 *   bun bench/perf.ts --port 7490    # override port (default 7490)
 *   bun bench/perf.ts --update-baseline  # save this run as the new baseline
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const SEED_ONLY = flag("--seed-only");
const BENCH_ONLY = flag("--bench-only");
const RESET = flag("--reset");
const UPDATE_BASELINE = flag("--update-baseline");
const DOC_COUNT = Number.parseInt(opt("--docs", "10000"), 10);
const PORT = Number.parseInt(opt("--port", "7490"), 10);
const CONCURRENCY = Number.parseInt(opt("--concurrency", "50"), 10);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const APP_DIR = resolve(import.meta.dir, "..");
const BINARY = join(APP_DIR, "vektor");
// The binary stores data in ./data relative to its CWD.
// We use bench/ as the CWD so the DB lands in bench/data/.
const BENCH_DIR = import.meta.dir;
const DATA_DIR = join(BENCH_DIR, "data");
const SEED_STATE_FILE = join(DATA_DIR, "seed-state.json");
const SNAPSHOT_FILE = join(DATA_DIR, "baseline.json");
const BASE_URL = `http://127.0.0.1:${PORT}`;

mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Realistic content generators
// ---------------------------------------------------------------------------
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

const SECTION_TYPES = [
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

const DOC_STATUSES = ["draft", "review", "approved", "published", "deprecated", "archived"];
const DOC_PRIORITIES = ["p0", "p1", "p2", "p3"];
const OWNERS = ["alice", "bob", "charlie", "dana", "eve", "frank", "grace", "henry"];

const LOREM_SENTENCES = [
  "This document describes the system architecture and deployment topology.",
  "All engineers are expected to review this runbook before handling incidents.",
  "The API follows RESTful conventions with JSON request and response bodies.",
  "Security review is required before any changes are merged to the main branch.",
  "Performance benchmarks should be run after every major release.",
  "Monitoring dashboards are available in Grafana under the team namespace.",
  "Database migrations must be backwards compatible and support zero-downtime deploys.",
  "Service dependencies are documented in the adjacent architecture diagram.",
  "All configuration is managed via environment variables; no secrets in source.",
  "On-call rotation is published in PagerDuty and rotates weekly.",
  "Rate limiting applies to all public endpoints at 1000 requests per minute.",
  "Caching headers are set appropriately to avoid stale responses in production.",
  "The feature flag system allows gradual rollout without a code deploy.",
  "Integration tests run in CI against a real database instance.",
  "Documentation should be updated in the same PR as the code change.",
  "The search index is rebuilt nightly; manual rebuild is available via the API.",
  "All user data is encrypted at rest using AES-256 and in transit using TLS 1.3.",
  "Access control is enforced at the API layer; the frontend mirrors these checks.",
  "Audit logs capture every write operation with actor, resource, and timestamp.",
  "SLO targets: 99.9% availability, p99 latency < 200ms, error rate < 0.1%.",
];

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateHtml(title: string, paragraphs = 3): string {
  const paras = Array.from({ length: paragraphs }, () => {
    const sentences = Array.from(
      { length: randomInt(3, 7) },
      () => LOREM_SENTENCES[Math.floor(Math.random() * LOREM_SENTENCES.length)],
    );
    return `<p>${sentences.join(" ")}</p>`;
  });

  const headings = Array.from(
    { length: Math.min(paragraphs, 3) },
    (_, i) => `<h2>Section ${i + 1}</h2>${paras[i] ?? ""}`,
  );

  const codeBlock =
    Math.random() > 0.5
      ? `<pre><code>GET /api/v1/spaces/{spaceId}/documents\nAuthorization: Bearer &lt;token&gt;\n\n# Response\n{ "documents": [...], "total": 42 }</code></pre>`
      : "";

  return `<h1>${title}</h1>${headings.join("")}${codeBlock}${paras.slice(3).join("")}`;
}

function generateProperties(dept: string, section: string, i: number): Record<string, string> {
  return {
    title: `${dept} / ${section} / Doc ${i}`,
    status: randomItem(DOC_STATUSES),
    priority: randomItem(DOC_PRIORITIES),
    owner: randomItem(OWNERS),
    department: dept,
    section,
    version: `${randomInt(1, 5)}.${randomInt(0, 9)}.${randomInt(0, 9)}`,
    tags: [randomItem(DEPARTMENTS), randomItem(SECTION_TYPES)].join(","),
    reviewed: Math.random() > 0.5 ? "true" : "false",
  };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
async function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const headers = new Headers(opts.headers);
  headers.set("Content-Type", "application/json");
  return fetch(`${BASE_URL}${path}`, { ...opts, headers });
}

async function apiJson<T = unknown>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await api(path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${opts.method ?? "GET"} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------
async function pool<T>(
  items: (() => Promise<T>)[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<T[]> {
  const results: T[] = new Array(items.length);
  let idx = 0;
  let done = 0;

  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await items[i]();
      done++;
      onProgress?.(done, items.length);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Latency stats
// ---------------------------------------------------------------------------
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
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------
async function waitForServer(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/spaces`);
      if (res.status < 500) return;
    } catch {
      // not ready
    }
    await Bun.sleep(200);
  }
  throw new Error("Server did not become ready within timeout");
}

function killPortIfBusy(port: number): void {
  // Best-effort: kill any process already bound to the port so the new server
  // can bind. This prevents a lingering process from a prior crashed run from
  // silently hijacking `waitForServer` and serving requests against stale data.
  try {
    const result = Bun.spawnSync(["lsof", "-ti", `:${port}`]);
    const pids = new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);
    for (const pid of pids) {
      process.kill(Number(pid), "SIGKILL");
      console.log(`  Killed stale process PID ${pid} on port ${port}`);
    }
  } catch {
    // lsof unavailable or no process — ignore
  }
}

function startServer(): ReturnType<typeof Bun.spawn> {
  if (!existsSync(BINARY)) {
    throw new Error(
      `Release binary not found at ${BINARY}. Run 'task compile' first.`,
    );
  }

  killPortIfBusy(PORT);

  console.log(`Starting ${BINARY} on port ${PORT} (data dir: ${DATA_DIR})`);
  return Bun.spawn([BINARY, "serve", "--port", String(PORT), "--no-auth"], {
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      VEKTOR_OTEL_ENABLED: "0",
    },
    // CWD determines where ./data/ is created; keep bench data isolated from app data
    cwd: BENCH_DIR,
    stdout: "ignore",
    stderr: "pipe",
  });
}

// ---------------------------------------------------------------------------
// Seed state — skip seeding if already done and --reset not set
// ---------------------------------------------------------------------------
interface SeedState {
  spaceId: string;
  documentIds: string[];
  docCount: number;
  seededAt: string;
}

function loadSeedState(): SeedState | null {
  try {
    if (existsSync(SEED_STATE_FILE)) {
      return JSON.parse(readFileSync(SEED_STATE_FILE, "utf-8")) as SeedState;
    }
  } catch {}
  return null;
}

function saveSeedState(state: SeedState) {
  writeFileSync(SEED_STATE_FILE, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
async function seed(): Promise<SeedState> {
  console.log("\n=== SEED PHASE ===");

  // Create space
  const { space } = await apiJson<{ space: { id: string } }>("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({
      name: "Performance Test Space",
      slug: `perf-${Date.now()}`,
    }),
  });
  const spaceId = space.id;
  console.log(`Space: ${spaceId}`);

  // Build hierarchy: DEPARTMENTS × SECTION_TYPES → leaf docs
  // Each dept gets a parent doc, each section gets a child of dept,
  // leaf docs fill the requested total count.
  const deptDocIds: Record<string, string> = {};
  const sectionDocIds: Record<string, string> = {};

  // 1. Department-level docs (10)
  for (const dept of DEPARTMENTS) {
    const { document } = await apiJson<{ document: { id: string } }>(
      `/api/v1/spaces/${spaceId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          content: generateHtml(`${dept} Overview`, 2),
          properties: { title: `${dept} Overview`, status: "published", department: dept },
        }),
      },
    );
    deptDocIds[dept] = document.id;
  }
  console.log(`  Created ${DEPARTMENTS.length} department documents`);

  // 2. Section-level docs (10 depts × 10 sections = 100)
  for (const dept of DEPARTMENTS) {
    for (const section of SECTION_TYPES) {
      const { document } = await apiJson<{ document: { id: string } }>(
        `/api/v1/spaces/${spaceId}/documents`,
        {
          method: "POST",
          body: JSON.stringify({
            content: generateHtml(`${dept} ${section}`, 2),
            properties: {
              title: `${dept} ${section}`,
              status: "published",
              department: dept,
              section,
            },
            parentId: deptDocIds[dept],
          }),
        },
      );
      sectionDocIds[`${dept}/${section}`] = document.id;
    }
  }
  console.log(`  Created ${DEPARTMENTS.length * SECTION_TYPES.length} section documents`);

  // 3. Leaf documents filling the remainder of DOC_COUNT
  const leafCount = DOC_COUNT - DEPARTMENTS.length - DEPARTMENTS.length * SECTION_TYPES.length;
  const docsPerSection = Math.ceil(leafCount / (DEPARTMENTS.length * SECTION_TYPES.length));

  const leafIds: string[] = [];
  let leafCreated = 0;

  const deptSectionPairs = DEPARTMENTS.flatMap((d) =>
    SECTION_TYPES.map((s) => ({ dept: d, section: s })),
  );

  const createTasks: (() => Promise<void>)[] = [];

  for (const { dept, section } of deptSectionPairs) {
    const parentId = sectionDocIds[`${dept}/${section}`];
    for (let i = 0; i < docsPerSection && leafCreated < leafCount; i++, leafCreated++) {
      const localI = leafCreated;
      const title = `${dept} ${section} Doc ${localI}`;
      createTasks.push(async () => {
        const { document } = await apiJson<{ document: { id: string } }>(
          `/api/v1/spaces/${spaceId}/documents`,
          {
            method: "POST",
            body: JSON.stringify({
              content: generateHtml(title, randomInt(2, 6)),
              properties: generateProperties(dept, section, localI),
              parentId,
            }),
          },
        );
        leafIds.push(document.id);
      });
    }
  }

  let lastPct = 0;
  await pool(createTasks, CONCURRENCY, (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      process.stdout.write(`  Creating leaf docs: ${pct}% (${done}/${total})\r`);
    }
  });
  console.log(`\n  Created ${leafIds.length} leaf documents`);

  const allDocIds = [
    ...Object.values(deptDocIds),
    ...Object.values(sectionDocIds),
    ...leafIds,
  ];

  // 4. Revisions: give each leaf document 3–15 revisions.
  // IMPORTANT: revisions for a single document must be written sequentially
  // (the server increments currentRev and a concurrent write causes a gap that
  // breaks subsequent GETs). Parallelism is across documents, not within one.
  console.log("\n  Creating revisions...");

  // "hot" docs (top 5%) get 15-30 revisions, the rest get 2-8
  // Keeping counts realistic but bounded so seeding stays under ~15 minutes.
  const docRevCounts = leafIds.map((docId) => ({
    docId,
    count: Math.random() < 0.05 ? randomInt(8, 15) : randomInt(1, 4),
  }));
  const totalRevs = docRevCounts.reduce((s, d) => s + d.count, 0);
  let revsCreated = 0;
  lastPct = 0;

  // SQLite serialises writes; concurrency of 2 minimises lock-wait overhead.
  const REV_CONCURRENCY = Math.min(CONCURRENCY, 2);

  const revDocTasks: (() => Promise<void>)[] = docRevCounts.map(({ docId, count }) => async () => {
    for (let r = 0; r < count; r++) {
      const res = await api(`/api/v1/spaces/${spaceId}/documents/${docId}`, {
        method: "PUT",
        body: JSON.stringify({
          content: generateHtml(`Revision ${r}`, randomInt(1, 4)),
        }),
      });
      if (!res.ok) {
        // Drain body to avoid socket hang; ignore the error
        await res.text().catch(() => {});
      }
      revsCreated++;
      const pct = Math.floor((revsCreated / totalRevs) * 100);
      if (pct >= lastPct + 10) {
        lastPct = pct;
        process.stdout.write(`  Creating revisions: ${pct}% (${revsCreated}/${totalRevs})\r`);
      }
    }
  });

  await pool(revDocTasks, REV_CONCURRENCY);
  console.log(`\n  Created ~${revsCreated} revisions across ${leafIds.length} documents`);

  // 5. Comments: ~60% of leaf docs get 1–5 top-level comments; replies are
  //    chained sequentially so the parent ID is known before the reply is sent.
  console.log("\n  Creating comments...");
  let commentsCreated = 0;

  const commentDocTasks: (() => Promise<void>)[] = leafIds
    .filter(() => Math.random() < 0.6)
    .map((docId) => async () => {
      const topCount = randomInt(1, 5);
      const topIds: string[] = [];

      // Top-level comments (need reference)
      for (let c = 0; c < topCount; c++) {
        const res = await api(
          `/api/v1/spaces/${spaceId}/documents/${docId}/comments`,
          {
            method: "POST",
            body: JSON.stringify({
              content: randomItem(LOREM_SENTENCES),
              reference: `block-${randomInt(1, 20)}`,
              type: "text",
            }),
          },
        );
        if (res.ok) {
          const { comment } = (await res.json()) as { comment: { id: string } };
          topIds.push(comment.id);
          commentsCreated++;
        } else {
          await res.text().catch(() => {});
        }
      }

      // Replies (sequentially after parents exist)
      for (const parentId of topIds) {
        if (Math.random() > 0.3) continue;
        for (let r = 0; r < randomInt(1, 3); r++) {
          const res = await api(
            `/api/v1/spaces/${spaceId}/documents/${docId}/comments`,
            {
              method: "POST",
              body: JSON.stringify({
                content: randomItem(LOREM_SENTENCES),
                parentId,
                type: "text",
              }),
            },
          );
          if (res.ok) commentsCreated++;
          else await res.text().catch(() => {});
        }
      }
    });

  lastPct = 0;
  await pool(commentDocTasks, Math.min(CONCURRENCY, 20), (done, total) => {
    const pct = Math.floor((done / total) * 100);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      process.stdout.write(`  Creating comments: ${pct}% (${done}/${total} docs)\r`);
    }
  });
  console.log(`\n  Created ${commentsCreated} comments`);

  const state: SeedState = {
    spaceId,
    documentIds: allDocIds,
    docCount: allDocIds.length,
    seededAt: new Date().toISOString(),
  };
  saveSeedState(state);
  console.log(`\nSeed complete: ${allDocIds.length} documents in space ${spaceId}`);
  return state;
}

// ---------------------------------------------------------------------------
// Benchmark
// ---------------------------------------------------------------------------
interface BenchStats {
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
}

interface PayloadStats {
  avgBytes: number;
  minBytes: number;
  maxBytes: number;
  totalBytes: number;
}

interface SearchQuality {
  avgResultCount: number;
  zeroResultQueries: number;
  totalQueries: number;
}

interface ColdStartResult {
  spawnToFirstByteMs: number;
  spawnToReadyMs: number;
}

interface BenchResult {
  timestamp: string;
  docCount: number;
  // --- latency ---
  documentFetch: BenchStats;
  documentList: BenchStats;
  documentListPaginated: BenchStats;
  revisionHistory: BenchStats;
  commentList: BenchStats;
  auditLogList: BenchStats;
  spaceAuditLog: BenchStats;
  search: BenchStats;
  childrenList: BenchStats;
  propertyPatch: BenchStats;
  documentWrite: BenchStats;
  // --- payload sizes ---
  payloads: Record<string, PayloadStats>;
  // --- search quality ---
  searchQuality: SearchQuality;
  // --- cold start ---
  coldStart: ColdStartResult;
}

// measureN — collects timing + optional body bytes
async function measureN(
  label: string,
  n: number,
  taskFn: (i: number) => Promise<number | void>,
  concurrency = CONCURRENCY,
): Promise<BenchStats> {
  const times: number[] = [];
  let errors = 0;
  const tasks = Array.from({ length: n }, (_, i) => async () => {
    const t0 = performance.now();
    try {
      await taskFn(i);
      times.push(performance.now() - t0);
    } catch {
      errors++;
    }
  });
  await pool(tasks, concurrency);
  const errorRate = errors / n;
  if (times.length === 0) {
    console.log(`  ${label.padEnd(32)} ALL ${n} REQUESTS FAILED`);
    throw new Error(`${label}: all ${n} requests failed`);
  }
  if (errorRate > 0.05) {
    console.log(`  ${label.padEnd(32)} HIGH ERROR RATE: ${errors}/${n} failed (${(errorRate * 100).toFixed(1)}%)`);
    throw new Error(`${label}: error rate ${(errorRate * 100).toFixed(1)}% exceeds 5% threshold`);
  }
  const s = stats(times);
  const errNote = errors > 0 ? `  errors=${errors}` : "";
  console.log(
    `  ${label.padEnd(32)} avg=${s.avg.toFixed(1)}ms  p50=${s.p50.toFixed(1)}ms  p95=${s.p95.toFixed(1)}ms  p99=${s.p99.toFixed(1)}ms  (n=${s.count}${errNote})`,
  );
  return s;
}

// measurePayload — runs n requests and collects body byte sizes
async function measurePayload(
  label: string,
  n: number,
  taskFn: (i: number) => Promise<number>,
): Promise<PayloadStats> {
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    try {
      sizes.push(await taskFn(i));
    } catch {
      // skip failures
    }
  }
  if (sizes.length === 0) return { avgBytes: 0, minBytes: 0, maxBytes: 0, totalBytes: 0 };
  const total = sizes.reduce((a, b) => a + b, 0);
  const sorted = [...sizes].sort((a, b) => a - b);
  const ps = {
    avgBytes: Math.round(total / sizes.length),
    minBytes: sorted[0],
    maxBytes: sorted[sorted.length - 1],
    totalBytes: total,
  };
  console.log(
    `  ${label.padEnd(32)} avg=${fmt(ps.avgBytes)}  min=${fmt(ps.minBytes)}  max=${fmt(ps.maxBytes)}  (n=${sizes.length})`,
  );
  return ps;
}

function fmt(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${bytes}B`;
}

async function measureColdStart(): Promise<ColdStartResult> {
  killPortIfBusy(PORT + 1);
  const t0 = performance.now();
  const coldServer = Bun.spawn([BINARY, "serve", "--port", String(PORT + 1), "--no-auth"], {
    env: { ...process.env, HOST: "127.0.0.1", VEKTOR_OTEL_ENABLED: "0" },
    cwd: BENCH_DIR,
    stdout: "ignore",
    stderr: "ignore",
  });

  const coldBase = `http://127.0.0.1:${PORT + 1}`;
  let spawnToFirstByteMs = 0;
  let spawnToReadyMs = 0;

  try {
    // Time to first non-error response (TTFB from process spawn)
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${coldBase}/api/v1/spaces`);
        if (res.status < 500) {
          spawnToFirstByteMs = performance.now() - t0;
          await res.text();
          break;
        }
        await res.text();
      } catch {
        // not ready
      }
      await Bun.sleep(50);
    }

    // Time until it can handle a real document-list request
    const t1 = performance.now();
    const deadline2 = Date.now() + 10_000;
    while (Date.now() < deadline2) {
      try {
        const res = await fetch(`${coldBase}/api/v1/spaces`);
        if (res.ok) { await res.text(); break; }
        await res.text();
      } catch {
        await Bun.sleep(50);
      }
    }
    spawnToReadyMs = performance.now() - t0;
  } finally {
    coldServer.kill();
    await coldServer.exited;
  }

  console.log(
    `  ${"Cold start (spawn→first byte)".padEnd(32)} ${spawnToFirstByteMs.toFixed(0)}ms`,
  );
  console.log(
    `  ${"Cold start (spawn→ready)".padEnd(32)} ${spawnToReadyMs.toFixed(0)}ms`,
  );
  return { spawnToFirstByteMs, spawnToReadyMs };
}

async function bench(state: SeedState): Promise<BenchResult> {
  const { spaceId, documentIds } = state;

  console.log("\n=== BENCHMARK PHASE ===");
  console.log(`  ${documentIds.length} documents in DB\n`);

  // ── Cold start timing ─────────────────────────────────────────────────────
  console.log("── Cold start ──");
  const coldStart = await measureColdStart();

  // ── Read latency ──────────────────────────────────────────────────────────
  console.log("\n── Read latency ──");

  const documentFetch = await measureN("GET document", 500, async () => {
    const id = randomItem(documentIds);
    await apiJson(`/api/v1/spaces/${spaceId}/documents/${id}`);
  });

  const documentList = await measureN("GET documents (page 1, 500)", 30, async () => {
    await apiJson(`/api/v1/spaces/${spaceId}/documents?limit=500`);
  });

  // Pre-walk to a deep cursor position (page 100 = offset ~5000) so the benchmark
  // measures keyset seeks at depth, where offset pagination would scan ~5000 rows.
  let deepCursor = "";
  {
    let cur = "";
    for (let i = 0; i < 100; i++) {
      const url = cur
        ? `/api/v1/spaces/${spaceId}/documents?limit=50&cursor=${encodeURIComponent(cur)}`
        : `/api/v1/spaces/${spaceId}/documents?limit=50`;
      const data = await apiJson<{ nextCursor?: string | null }>(url);
      if (!data.nextCursor) break;
      cur = data.nextCursor;
    }
    deepCursor = cur;
  }
  const documentListPaginated = await measureN("GET documents (cursor, 50)", 50, async () => {
    const url = deepCursor
      ? `/api/v1/spaces/${spaceId}/documents?limit=50&cursor=${encodeURIComponent(deepCursor)}`
      : `/api/v1/spaces/${spaceId}/documents?limit=50`;
    await apiJson(url);
  });

  const revisionHistory = await measureN("GET revisions", 300, async () => {
    const id = randomItem(documentIds);
    await apiJson(`/api/v1/spaces/${spaceId}/documents/${id}/revisions`);
  });

  const commentList = await measureN("GET comments", 300, async () => {
    const id = randomItem(documentIds);
    await apiJson(`/api/v1/spaces/${spaceId}/documents/${id}/comments`);
  });

  const auditLogList = await measureN("GET doc audit-logs", 300, async () => {
    const id = randomItem(documentIds);
    await apiJson(`/api/v1/spaces/${spaceId}/documents/${id}/audit-logs`);
  });

  const spaceAuditLog = await measureN("GET space audit-logs", 50, async () => {
    await apiJson(`/api/v1/spaces/${spaceId}/audit-logs?limit=100`);
  });

  const childrenList = await measureN("GET children", 300, async () => {
    const id = randomItem(documentIds);
    await apiJson(`/api/v1/spaces/${spaceId}/documents/${id}/children`);
  });

  // ── Write latency ─────────────────────────────────────────────────────────
  console.log("\n── Write latency ──");

  const propertyPatch = await measureN("PATCH properties", 300, async (i) => {
    const id = randomItem(documentIds);
    const statuses = DOC_STATUSES;
    await apiJson(`/api/v1/spaces/${spaceId}/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({
        properties: {
          status: statuses[i % statuses.length],
          reviewed: i % 2 === 0 ? "true" : "false",
          version: `${randomInt(1, 9)}.${randomInt(0, 9)}.${randomInt(0, 9)}`,
        },
      }),
    });
  }, Math.min(CONCURRENCY, 20));

  const documentWrite = await measureN("PUT document (new revision)", 200, async (i) => {
    const id = randomItem(documentIds);
    await apiJson(`/api/v1/spaces/${spaceId}/documents/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        content: generateHtml(`Bench revision ${i}`, randomInt(1, 3)),
      }),
    });
  }, Math.min(CONCURRENCY, 10));

  // ── Search ────────────────────────────────────────────────────────────────
  console.log("\n── Search ──");

  const SEARCH_TERMS = [
    "architecture", "deploy", "security", "API",
    "monitoring", "review", "onboarding", "migration",
    "performance", "database", "SLO", "incident",
  ];
  let totalResults = 0;
  let zeroResultQueries = 0;
  const searchQueries = SEARCH_TERMS.length * 5; // 5 passes per term

  const search = await measureN("GET search", searchQueries, async (i) => {
    const term = SEARCH_TERMS[i % SEARCH_TERMS.length];
    const data = await apiJson<{ documents?: unknown[] }>(
      `/api/v1/spaces/${spaceId}/search?q=${encodeURIComponent(term)}&limit=20`,
    );
    const count = data.documents?.length ?? 0;
    totalResults += count;
    if (count === 0) zeroResultQueries++;
  }, Math.min(CONCURRENCY, 10));

  const searchQuality: SearchQuality = {
    avgResultCount: totalResults / searchQueries,
    zeroResultQueries,
    totalQueries: searchQueries,
  };
  console.log(
    `  ${"Search quality".padEnd(32)} avg results=${searchQuality.avgResultCount.toFixed(1)}  zero-result=${zeroResultQueries}/${searchQueries}`,
  );

  // ── Payload sizes ─────────────────────────────────────────────────────────
  console.log("\n── Payload sizes ──");

  const getBytes = async (path: string) => {
    const res = await api(path);
    const buf = await res.arrayBuffer();
    return buf.byteLength;
  };

  const payloads: Record<string, PayloadStats> = {};

  payloads.documentFetch = await measurePayload("GET document", 50, async () =>
    getBytes(`/api/v1/spaces/${spaceId}/documents/${randomItem(documentIds)}`),
  );

  payloads.documentListPage = await measurePayload("GET documents (50)", 20, async () =>
    getBytes(`/api/v1/spaces/${spaceId}/documents?limit=50`),
  );

  payloads.documentListLarge = await measurePayload("GET documents (500)", 10, async () =>
    getBytes(`/api/v1/spaces/${spaceId}/documents?limit=500`),
  );

  payloads.revisionHistory = await measurePayload("GET revisions", 50, async () =>
    getBytes(`/api/v1/spaces/${spaceId}/documents/${randomItem(documentIds)}/revisions`),
  );

  payloads.commentList = await measurePayload("GET comments", 50, async () =>
    getBytes(`/api/v1/spaces/${spaceId}/documents/${randomItem(documentIds)}/comments`),
  );

  payloads.searchResult = await measurePayload("GET search (limit 20)", 20, async (i) => {
    const term = SEARCH_TERMS[i % SEARCH_TERMS.length];
    return getBytes(`/api/v1/spaces/${spaceId}/search?q=${encodeURIComponent(term)}&limit=20`);
  });

  return {
    timestamp: new Date().toISOString(),
    docCount: documentIds.length,
    documentFetch,
    documentList,
    documentListPaginated,
    revisionHistory,
    commentList,
    auditLogList,
    spaceAuditLog,
    search,
    childrenList,
    propertyPatch,
    documentWrite,
    payloads,
    searchQuality,
    coldStart,
  };
}

// ---------------------------------------------------------------------------
// Baseline comparison
// ---------------------------------------------------------------------------
interface Baseline {
  result: BenchResult;
}

function loadBaseline(): Baseline | null {
  try {
    if (existsSync(SNAPSHOT_FILE)) {
      return JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8")) as Baseline;
    }
  } catch {}
  return null;
}

function saveBaseline(result: BenchResult) {
  writeFileSync(SNAPSHOT_FILE, JSON.stringify({ result }, null, 2));
  console.log(`\nBaseline saved to ${SNAPSHOT_FILE}`);
}

// Threshold: p99 must not exceed this multiplier over baseline p99
const REGRESSION_THRESHOLD = 1.5; // 50% slower
const WARNING_THRESHOLD = 1.25; // 25% slower

type LatencyKey = keyof Pick<BenchResult,
  "documentFetch" | "documentList" | "documentListPaginated" |
  "revisionHistory" | "commentList" | "auditLogList" | "spaceAuditLog" |
  "search" | "childrenList" | "propertyPatch" | "documentWrite"
>;

function report(current: BenchResult, baseline: Baseline | null) {
  console.log("\n=== RESULTS ===");
  if (!baseline) console.log("No baseline — this run will become the baseline.\n");

  let hasRegression = false;
  let hasWarning = false;

  // ── Latency table ──────────────────────────────────────────────────────────
  const metrics: Array<{ key: LatencyKey; label: string }> = [
    { key: "documentFetch",          label: "GET document" },
    { key: "documentList",           label: "GET documents (page 1, 500)" },
    { key: "documentListPaginated",  label: "GET documents (cursor, 50)" },
    { key: "revisionHistory",        label: "GET revisions" },
    { key: "commentList",            label: "GET comments" },
    { key: "auditLogList",           label: "GET doc audit-logs" },
    { key: "spaceAuditLog",          label: "GET space audit-logs" },
    { key: "childrenList",           label: "GET children" },
    { key: "propertyPatch",          label: "PATCH properties" },
    { key: "documentWrite",          label: "PUT document (revision)" },
    { key: "search",                 label: "GET search" },
  ];

  const W = 36;
  const sep = "─".repeat(W + 52);
  console.log(sep);
  console.log(`${"Metric".padEnd(W)} ${"avg".padStart(8)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"p99".padStart(8)}  vs baseline`);
  console.log(sep);

  for (const m of metrics) {
    const cur = current[m.key];
    if (cur.count === 0) {
      console.log(`${m.label.padEnd(W)} ${"FAILED".padStart(8)}`);
      continue;
    }
    const bas = baseline?.result[m.key];
    let vsText = "n/a";
    if (bas && bas.p99 > 0) {
      const ratio = cur.p99 / bas.p99;
      const absDeltaMs = cur.p99 - bas.p99;
      const pct = ((ratio - 1) * 100).toFixed(1);
      const sign = ratio > 1 ? "+" : "";
      // Require both a relative and absolute increase to avoid noise on fast endpoints.
      // Absolute floors: regressions need >50ms delta, warnings need >25ms delta.
      const isRegression = ratio >= REGRESSION_THRESHOLD && absDeltaMs > 50;
      const isWarning = ratio >= WARNING_THRESHOLD && absDeltaMs > 25;
      if (isRegression) {
        vsText = `REGRESSION ${sign}${pct}%`;
        hasRegression = true;
      } else if (isWarning) {
        vsText = `WARNING    ${sign}${pct}%`;
        hasWarning = true;
      } else if (ratio < 1) {
        vsText = `improved   ${sign}${pct}%`;
      } else {
        vsText = `ok         ${sign}${pct}%`;
      }
    }
    console.log(
      `${m.label.padEnd(W)} ${cur.avg.toFixed(1).padStart(7)}ms ${cur.p50.toFixed(1).padStart(7)}ms ${cur.p95.toFixed(1).padStart(7)}ms ${cur.p99.toFixed(1).padStart(7)}ms  ${vsText}`,
    );
  }
  console.log(sep);

  // ── Cold start ─────────────────────────────────────────────────────────────
  console.log(`\nCold start  spawn→first-byte: ${current.coldStart.spawnToFirstByteMs.toFixed(0)}ms   spawn→ready: ${current.coldStart.spawnToReadyMs.toFixed(0)}ms`);
  if (baseline) {
    const bcs = baseline.result.coldStart;
    const fbDelta = ((current.coldStart.spawnToFirstByteMs / bcs.spawnToFirstByteMs - 1) * 100).toFixed(1);
    const sign = current.coldStart.spawnToFirstByteMs > bcs.spawnToFirstByteMs ? "+" : "";
    console.log(`  vs baseline: first-byte ${sign}${fbDelta}%`);
  }

  // ── Search quality ─────────────────────────────────────────────────────────
  const sq = current.searchQuality;
  console.log(`\nSearch quality  avg results=${sq.avgResultCount.toFixed(1)}  zero-result queries=${sq.zeroResultQueries}/${sq.totalQueries}`);

  // ── Payload sizes ──────────────────────────────────────────────────────────
  console.log("\nPayload sizes:");
  const pW = 30;
  for (const [key, ps] of Object.entries(current.payloads)) {
    const label = {
      documentFetch: "GET document",
      documentListPage: "GET documents (50)",
      documentListLarge: "GET documents (500)",
      revisionHistory: "GET revisions",
      commentList: "GET comments",
      searchResult: "GET search (limit 20)",
    }[key] ?? key;
    const bas = baseline?.result.payloads[key];
    let delta = "";
    if (bas && bas.avgBytes > 0) {
      const pct = ((ps.avgBytes / bas.avgBytes - 1) * 100).toFixed(1);
      const sign = ps.avgBytes > bas.avgBytes ? "+" : "";
      delta = ` (${sign}${pct}% vs baseline)`;
    }
    console.log(
      `  ${label.padEnd(pW)} avg=${fmt(ps.avgBytes)}  min=${fmt(ps.minBytes)}  max=${fmt(ps.maxBytes)}${delta}`,
    );
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(sep.length)}`);
  if (hasRegression) {
    console.log("PERFORMANCE REGRESSION DETECTED — p99 latency ≥1.5× baseline (exits 1)");
  } else if (hasWarning) {
    console.log("PERFORMANCE WARNING — p99 latency ≥1.25× baseline");
  } else if (baseline) {
    console.log("All latency metrics within acceptable range.");
  }

  return { hasRegression, hasWarning };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Vektor performance benchmark`);
  console.log(`  Binary:      ${BINARY}`);
  console.log(`  DB dir:      ${DATA_DIR}`);
  console.log(`  Port:        ${PORT}`);
  console.log(`  Target docs: ${DOC_COUNT}`);
  console.log(`  Concurrency: ${CONCURRENCY}`);
  console.log();

  if (RESET) {
    if (existsSync(DATA_DIR)) {
      rmSync(DATA_DIR, { recursive: true });
      mkdirSync(DATA_DIR, { recursive: true });
      console.log("Removed existing bench data directory.");
    }
  }

  let existingSeed = BENCH_ONLY ? loadSeedState() : null;

  if (BENCH_ONLY && !existingSeed) {
    throw new Error("--bench-only specified but no seed state found. Run without --bench-only first.");
  }

  const server = startServer();
  let exitCode = 0;

  try {
    await waitForServer();
    console.log("Server ready.\n");

    let seedState: SeedState;

    if (BENCH_ONLY && existingSeed) {
      console.log(
        `Using existing seed: ${existingSeed.docCount} docs, seeded at ${existingSeed.seededAt}`,
      );
      seedState = existingSeed;
    } else {
      // Check if we can skip seeding (DB + seed state both exist)
      const cachedSeed = loadSeedState();
      if (cachedSeed && existsSync(join(DATA_DIR, "auth.db")) && !SEED_ONLY) {
        console.log(
          `Existing seed found (${cachedSeed.docCount} docs, seeded ${cachedSeed.seededAt}). Skipping seed.\n`,
        );
        seedState = cachedSeed;
      } else {
        seedState = await seed();
      }
    }

    if (SEED_ONLY) {
      console.log("\nDone (--seed-only mode).");
      return;
    }

    const result = await bench(seedState);

    const baseline = loadBaseline();
    const { hasRegression } = report(result, baseline);

    if (UPDATE_BASELINE || !baseline) {
      saveBaseline(result);
    } else {
      console.log(
        "\nRun with --update-baseline to promote these results to the new baseline.",
      );
    }

    if (hasRegression) {
      exitCode = 1;
    }
  } finally {
    server.kill();
    await server.exited;
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
