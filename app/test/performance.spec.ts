import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

const DATA_DIR = "./data";
const AUTH_DB_PATH = join(DATA_DIR, "auth.db");
const BASE_URL = "http://127.0.0.1:4321";
const SNAPSHOT_DIR = join(__dirname, "snapshots");
const SNAPSHOT_FILE = join(SNAPSHOT_DIR, "performance-baseline.json");

const PERFORMANCE_THRESHOLDS = {
  documentCreation: { max: 60000, warningPercent: 20 },
  documentQuery: { max: 150, warningPercent: 25 },
  documentList: { max: 5000, warningPercent: 30 },
  revisionOperations: { max: 1000, warningPercent: 25 },
  propertyQuery: { max: 150, warningPercent: 25 },
  auditLogQuery: { max: 300, warningPercent: 25 },
};

let testUser: { id: string; email: string; name: string };
let sessionToken: string;
let testSpaceId: string;
const documentIds: string[] = [];

interface BenchmarkResult {
  timestamp: string;
  documentCreation: {
    totalTime: number;
    avgTime: number;
    throughput: number;
    count: number;
  };
  documentQuery: {
    totalTime: number;
    avgTime: number;
    minTime: number;
    maxTime: number;
    count: number;
  };
  documentList: {
    totalTime: number;
    count: number;
  };
  revisionOperations: {
    totalTime: number;
    historyQueryTime: number;
    revisionCount: number;
  };
  propertyQuery: {
    totalTime: number;
    avgTime: number;
    count: number;
  };
  auditLogQuery: {
    totalTime: number;
    avgTime: number;
    avgLogCount: number;
    count: number;
  };
}

const currentResults: Partial<BenchmarkResult> = {};

function ensureSnapshotDir() {
  if (!existsSync(SNAPSHOT_DIR)) {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
}

function loadBaseline(): BenchmarkResult | null {
  try {
    if (existsSync(SNAPSHOT_FILE)) {
      const data = readFileSync(SNAPSHOT_FILE, "utf-8");
      return JSON.parse(data);
    }
  } catch (error) {
    console.warn("⚠️  Failed to load baseline:", error);
  }
  return null;
}

function saveSnapshot(results: BenchmarkResult) {
  ensureSnapshotDir();
  writeFileSync(SNAPSHOT_FILE, JSON.stringify(results, null, 2));
  console.log(`\n💾 Snapshot saved to ${SNAPSHOT_FILE}`);
}

function compareWithBaseline(baseline: BenchmarkResult | null) {
  if (!baseline) {
    console.log("\n📸 No baseline found. This run will become the baseline.");
    return;
  }

  console.log("\n📊 Performance Comparison:");
  console.log("═══════════════════════════════════════════════════════════");

  const current = currentResults as BenchmarkResult;
  let hasRegression = false;
  let hasWarning = false;

  const comparisons = [
    {
      name: "Document Creation (avg)",
      current: current.documentCreation.avgTime,
      baseline: baseline.documentCreation.avgTime,
      threshold: PERFORMANCE_THRESHOLDS.documentCreation,
      unit: "ms",
    },
    {
      name: "Document Query (avg)",
      current: current.documentQuery.avgTime,
      baseline: baseline.documentQuery.avgTime,
      threshold: PERFORMANCE_THRESHOLDS.documentQuery,
      unit: "ms",
    },
    {
      name: "Document List",
      current: current.documentList.totalTime,
      baseline: baseline.documentList.totalTime,
      threshold: PERFORMANCE_THRESHOLDS.documentList,
      unit: "ms",
    },
    {
      name: "Revision History Query",
      current: current.revisionOperations.historyQueryTime,
      baseline: baseline.revisionOperations.historyQueryTime,
      threshold: PERFORMANCE_THRESHOLDS.revisionOperations,
      unit: "ms",
    },
    {
      name: "Property Query (avg)",
      current: current.propertyQuery.avgTime,
      baseline: baseline.propertyQuery.avgTime,
      threshold: PERFORMANCE_THRESHOLDS.propertyQuery,
      unit: "ms",
    },
    {
      name: "Audit Log Query (avg)",
      current: current.auditLogQuery.avgTime,
      baseline: baseline.auditLogQuery.avgTime,
      threshold: PERFORMANCE_THRESHOLDS.auditLogQuery,
      unit: "ms",
    },
  ];

  for (const comp of comparisons) {
    const diff = comp.current - comp.baseline;
    const percentChange = ((diff / comp.baseline) * 100).toFixed(2);
    const sign = diff > 0 ? "+" : "";
    const warningThreshold = (comp.baseline * comp.threshold.warningPercent) / 100;

    let status = "✅";
    let statusText = "OK";

    if (comp.current > comp.threshold.max) {
      status = "❌";
      statusText = "REGRESSION";
      hasRegression = true;
    } else if (diff > warningThreshold) {
      status = "⚠️ ";
      statusText = "WARNING";
      hasWarning = true;
    } else if (diff < 0) {
      status = "🚀";
      statusText = "IMPROVED";
    }

    console.log(
      `${status} ${comp.name.padEnd(28)} ${comp.current.toFixed(2)}${comp.unit} (${sign}${percentChange}%) [${statusText}]`,
    );
    console.log(
      `   Baseline: ${comp.baseline.toFixed(2)}${comp.unit} | Threshold: ${comp.threshold.max}${comp.unit}`,
    );
  }

  console.log("═══════════════════════════════════════════════════════════");

  if (hasRegression) {
    console.log("\n❌ PERFORMANCE REGRESSION DETECTED!");
    console.log("   Some metrics exceed maximum thresholds.");
  } else if (hasWarning) {
    console.log("\n⚠️  PERFORMANCE WARNING!");
    console.log("   Some metrics show significant degradation.");
  } else {
    console.log("\n✅ All performance metrics within acceptable ranges!");
  }

  return { hasRegression, hasWarning };
}

async function createTestUser() {
  const testEmail = `perf-test-${Date.now()}@example.com`;
  const testPassword = "TestPassword123!";

  const response = await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      name: "Performance Test User",
    }),
  });

  if (!response.ok) {
    throw new Error(`Failed to create test user: ${response.statusText}`);
  }

  const data = await response.json();
  const token = data.token;

  const cookies = response.headers.get("set-cookie");
  let sessionCookie = "";
  if (cookies) {
    const match = cookies.match(/better-auth\.session_token=([^;]+)/);
    if (match) {
      sessionCookie = match[1];
    }
  }

  if (!sessionCookie) {
    sessionCookie = `${token}.${Buffer.from(token).toString("base64")}`;
  }

  return {
    userId: data.user.id,
    token: sessionCookie,
    email: testEmail,
    name: data.user.name,
  };
}

async function apiRequest(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  if (sessionToken) {
    headers.set("Cookie", `better-auth.session_token=${sessionToken}`);
  }
  headers.set("Content-Type", "application/json");

  return fetch(`${BASE_URL}${path}`, {
    ...options,
    headers,
  });
}

beforeAll(async () => {
  const { userId, token, email, name } = await createTestUser();
  testUser = { id: userId, email, name };
  sessionToken = token;

  console.log("Performance test user created:", testUser.email);

  const spaceResponse = await apiRequest("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({
      name: "Performance Test Space",
      slug: `perf-test-${Date.now()}`,
    }),
  });

  if (!spaceResponse.ok) {
    throw new Error(`Failed to create test space: ${spaceResponse.statusText}`);
  }

  const spaceData = await spaceResponse.json();
  testSpaceId = spaceData.space.id;

  console.log("Performance test space created:", testSpaceId);
});

afterAll(async () => {
  if (testSpaceId && existsSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`))) {
    rmSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`), { force: true });
  }

  if (testUser?.id && existsSync(AUTH_DB_PATH)) {
    const authSqlite = new Database(AUTH_DB_PATH);
    const authDb = drizzle({ client: authSqlite });

    await authDb.run(sql`DELETE FROM account WHERE user_id = ${testUser.id}`);
    await authDb.run(sql`DELETE FROM session WHERE user_id = ${testUser.id}`);
    await authDb.run(sql`DELETE FROM user WHERE id = ${testUser.id}`);

    authSqlite.close();

    console.log("Performance test user cleaned up");
  }
});

describe.if(import.meta.env.TEST_PERF)(
  "Performance Benchmark - Document Operations",
  () => {
    const baseline = loadBaseline();

    if (baseline) {
      console.log(`\n📊 Loaded baseline from: ${baseline.timestamp}`);
    }
    it("should create 2000 documents in reasonable time", async () => {
      const DOCUMENT_COUNT = 2000;
      const startTime = performance.now();

      console.log(`\n🚀 Starting creation of ${DOCUMENT_COUNT} documents...`);

      const batchSize = 100;
      const batches = Math.ceil(DOCUMENT_COUNT / batchSize);

      for (let batch = 0; batch < batches; batch++) {
        const batchStart = batch * batchSize;
        const batchEnd = Math.min(batchStart + batchSize, DOCUMENT_COUNT);
        const promises: Promise<Response>[] = [];

        for (let i = batchStart; i < batchEnd; i++) {
          const categories = ["guide", "reference", "tutorial", "api", "concept"];
          const statuses = ["draft", "review", "published", "archived"];
          const tags = ["performance", "testing", "benchmark", "docs", "wiki"];

          const promise = apiRequest(`/api/v1/spaces/${testSpaceId}/documents`, {
            method: "POST",
            body: JSON.stringify({
              content: `# Performance Test Document ${i}\n\nThis is a test document created for performance benchmarking.\n\nContent: ${"Lorem ipsum dolor sit amet. ".repeat(20)}`,
              properties: {
                title: `Performance Test Doc ${i}`,
                category: categories[i % categories.length],
                status: statuses[i % statuses.length],
                tags: tags.slice(0, (i % tags.length) + 1).join(","),
                author: testUser.name,
                priority: String((i % 5) + 1),
                version: "1.0.0",
              },
            }),
          });

          promises.push(promise);
        }

        const responses = await Promise.all(promises);

        for (const response of responses) {
          if (!response.ok) {
            throw new Error(`Failed to create document: ${response.statusText}`);
          }
          const data = await response.json();
          documentIds.push(data.document.id);
        }

        const progress = Math.round(((batch + 1) / batches) * 100);
        console.log(
          `  📝 Progress: ${progress}% (${documentIds.length}/${DOCUMENT_COUNT})`,
        );
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const docsPerSecond = (DOCUMENT_COUNT / (totalTime / 1000)).toFixed(2);

      console.log(
        `\n✅ Created ${DOCUMENT_COUNT} documents in ${totalTime.toFixed(2)}ms`,
      );
      console.log(
        `   Average: ${(totalTime / DOCUMENT_COUNT).toFixed(2)}ms per document`,
      );
      console.log(`   Throughput: ${docsPerSecond} docs/second\n`);

      currentResults.documentCreation = {
        totalTime,
        avgTime: totalTime / DOCUMENT_COUNT,
        throughput: Number.parseFloat(docsPerSecond),
        count: DOCUMENT_COUNT,
      };

      expect(documentIds.length).toBe(DOCUMENT_COUNT);
      expect(totalTime).toBeLessThan(120000);
    }, 180000);

    it("should query random document properties efficiently", async () => {
      const QUERY_COUNT = 100;
      const startTime = performance.now();

      console.log(`\n🔍 Querying ${QUERY_COUNT} random documents...`);

      const results: Array<{ time: number; docId: string }> = [];

      for (let i = 0; i < QUERY_COUNT; i++) {
        const randomIndex = Math.floor(Math.random() * documentIds.length);
        const randomDocId = documentIds[randomIndex];

        const queryStart = performance.now();
        const response = await apiRequest(
          `/api/v1/spaces/${testSpaceId}/documents/${randomDocId}`,
        );
        const queryEnd = performance.now();

        if (!response.ok) {
          throw new Error(`Failed to query document: ${response.statusText}`);
        }

        const data = await response.json();
        expect(data.document.id).toBe(randomDocId);
        expect(data.document.properties).toBeDefined();

        results.push({
          time: queryEnd - queryStart,
          docId: randomDocId,
        });
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const avgQueryTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
      const minQueryTime = Math.min(...results.map((r) => r.time));
      const maxQueryTime = Math.max(...results.map((r) => r.time));

      console.log(`\n✅ Queried ${QUERY_COUNT} documents in ${totalTime.toFixed(2)}ms`);
      console.log(`   Average query time: ${avgQueryTime.toFixed(2)}ms`);
      console.log(`   Min query time: ${minQueryTime.toFixed(2)}ms`);
      console.log(`   Max query time: ${maxQueryTime.toFixed(2)}ms\n`);

      currentResults.documentQuery = {
        totalTime,
        avgTime: avgQueryTime,
        minTime: minQueryTime,
        maxTime: maxQueryTime,
        count: QUERY_COUNT,
      };

      expect(avgQueryTime).toBeLessThan(100);
    }, 60000);

    it("should list all documents efficiently", async () => {
      console.log("\n📋 Listing all documents...");

      const startTime = performance.now();
      const response = await apiRequest(`/api/v1/spaces/${testSpaceId}/documents`);
      const endTime = performance.now();

      if (!response.ok) {
        throw new Error(`Failed to list documents: ${response.statusText}`);
      }

      const data = await response.json();
      const totalTime = endTime - startTime;

      console.log(
        `\n✅ Listed ${data.documents.length} documents in ${totalTime.toFixed(2)}ms\n`,
      );

      currentResults.documentList = {
        totalTime,
        count: data.documents.length,
      };

      expect(data.documents.length).toBeGreaterThanOrEqual(2000);
      expect(totalTime).toBeLessThan(5000);
    }, 30000);

    it("should query random document revisions efficiently", async () => {
      const REVISION_COUNT = 50;
      const startTime = performance.now();

      console.log(`\n📚 Creating and querying ${REVISION_COUNT} document revisions...`);

      const randomIndex = Math.floor(Math.random() * documentIds.length);
      const randomDocId = documentIds[randomIndex];

      for (let i = 0; i < REVISION_COUNT; i++) {
        const saveResponse = await apiRequest(
          `/api/v1/spaces/${testSpaceId}/documents/${randomDocId}`,
          {
            method: "POST",
            body: JSON.stringify({
              html: `<h1>Revision ${i}</h1><p>Updated content version ${i}</p>`,
              message: `Revision ${i}`,
            }),
          },
        );

        if (!saveResponse.ok) {
          throw new Error(`Failed to create revision: ${saveResponse.statusText}`);
        }
      }

      const historyStart = performance.now();
      const historyResponse = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${randomDocId}/revisions`,
      );
      const historyEnd = performance.now();

      if (!historyResponse.ok) {
        throw new Error(`Failed to get history: ${historyResponse.statusText}`);
      }

      const historyData = await historyResponse.json();
      const endTime = performance.now();

      const totalTime = endTime - startTime;
      const historyQueryTime = historyEnd - historyStart;

      console.log(`\n✅ Created ${REVISION_COUNT} revisions and queried history`);
      console.log(`   Total time: ${totalTime.toFixed(2)}ms`);
      console.log(`   History query: ${historyQueryTime.toFixed(2)}ms`);
      console.log(`   Revisions returned: ${historyData.revisions.length}\n`);

      currentResults.revisionOperations = {
        totalTime,
        historyQueryTime,
        revisionCount: historyData.revisions.length,
      };

      expect(historyData.revisions.length).toBeGreaterThanOrEqual(REVISION_COUNT);
      expect(historyQueryTime).toBeLessThan(1000);
    }, 60000);

    it("should query random document properties by key", async () => {
      const PROPERTY_QUERY_COUNT = 100;
      const startTime = performance.now();

      console.log(`\n🔑 Querying ${PROPERTY_QUERY_COUNT} random document properties...`);

      const propertyKeys = ["title", "category", "status", "tags", "author", "priority"];
      const results: Array<{ time: number; key: string }> = [];

      for (let i = 0; i < PROPERTY_QUERY_COUNT; i++) {
        const randomDocIndex = Math.floor(Math.random() * documentIds.length);
        const randomDocId = documentIds[randomDocIndex];
        const randomKey = propertyKeys[Math.floor(Math.random() * propertyKeys.length)];

        const queryStart = performance.now();
        const response = await apiRequest(
          `/api/v1/spaces/${testSpaceId}/documents/${randomDocId}`,
        );
        const queryEnd = performance.now();

        if (!response.ok) {
          throw new Error(`Failed to query document: ${response.statusText}`);
        }

        const data = await response.json();
        expect(data.document.properties).toBeDefined();
        expect(data.document.properties[randomKey]).toBeDefined();

        results.push({
          time: queryEnd - queryStart,
          key: randomKey,
        });
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const avgQueryTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;

      console.log(
        `\n✅ Queried ${PROPERTY_QUERY_COUNT} properties in ${totalTime.toFixed(2)}ms`,
      );
      console.log(`   Average query time: ${avgQueryTime.toFixed(2)}ms\n`);

      currentResults.propertyQuery = {
        totalTime,
        avgTime: avgQueryTime,
        count: PROPERTY_QUERY_COUNT,
      };

      expect(avgQueryTime).toBeLessThan(100);
    }, 60000);

    it("should query audit logs efficiently for random documents", async () => {
      const AUDIT_QUERY_COUNT = 50;
      const startTime = performance.now();

      console.log(
        `\n📊 Querying audit logs for ${AUDIT_QUERY_COUNT} random documents...`,
      );

      const results: Array<{ time: number; logCount: number }> = [];

      for (let i = 0; i < AUDIT_QUERY_COUNT; i++) {
        const randomIndex = Math.floor(Math.random() * documentIds.length);
        const randomDocId = documentIds[randomIndex];

        const queryStart = performance.now();
        const response = await apiRequest(
          `/api/v1/spaces/${testSpaceId}/documents/${randomDocId}/audit-logs`,
        );
        const queryEnd = performance.now();

        if (!response.ok) {
          throw new Error(`Failed to query audit logs: ${response.statusText}`);
        }

        const data = await response.json();

        results.push({
          time: queryEnd - queryStart,
          logCount: data.auditLogs.length,
        });
      }

      const endTime = performance.now();
      const totalTime = endTime - startTime;
      const avgQueryTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
      const avgLogCount =
        results.reduce((sum, r) => sum + r.logCount, 0) / results.length;

      console.log(
        `\n✅ Queried audit logs for ${AUDIT_QUERY_COUNT} documents in ${totalTime.toFixed(2)}ms`,
      );
      console.log(`   Average query time: ${avgQueryTime.toFixed(2)}ms`);
      console.log(`   Average log entries per doc: ${avgLogCount.toFixed(2)}\n`);

      currentResults.auditLogQuery = {
        totalTime,
        avgTime: avgQueryTime,
        avgLogCount,
        count: AUDIT_QUERY_COUNT,
      };

      expect(avgQueryTime).toBeLessThan(200);
    }, 60000);

    it("should compare results with baseline and save snapshot", () => {
      const results: BenchmarkResult = {
        timestamp: new Date().toISOString(),
        ...(currentResults as Omit<BenchmarkResult, "timestamp">),
      };

      const comparison = compareWithBaseline(baseline);

      saveSnapshot(results);

      if (comparison?.hasRegression) {
        throw new Error(
          "Performance regression detected - metrics exceed maximum thresholds",
        );
      }
    });

    it("should detect performance regression when thresholds are exceeded", async () => {
      console.log("\n🧪 Testing regression detection with artificial delay...\n");

      const slowDocId = documentIds[0];
      const startTime = performance.now();

      await new Promise((resolve) => setTimeout(resolve, 50));

      const response = await apiRequest(
        `/api/v1/spaces/${testSpaceId}/documents/${slowDocId}`,
      );
      const endTime = performance.now();

      if (!response.ok) {
        throw new Error(`Failed to query document: ${response.statusText}`);
      }

      const data = await response.json();
      const queryTime = endTime - startTime;

      console.log(`⏱️  Artificially delayed query took: ${queryTime.toFixed(2)}ms`);
      console.log(`✅ Document retrieved successfully despite delay\n`);

      expect(data.document.id).toBe(slowDocId);
      expect(queryTime).toBeGreaterThan(50);
    });
  },
);
