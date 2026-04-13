import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { createHmac } from "node:crypto";

const DATA_DIR = "./data";
const BASE_URL = "http://127.0.0.1:4321";

let sessionToken: string;
let testSpaceId: string;

// --- Zip builder (mirrors cli.ts) ---

function crc32(buf: Buffer): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf-8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    chunks.push(local, compressed);

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compressed.length, 20);
    cd.writeUInt32LE(entry.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    central.push(cd);

    offset += local.length + compressed.length;
  }

  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eod = Buffer.alloc(22);
  eod.writeUInt32LE(0x06054b50, 0);
  eod.writeUInt16LE(0, 4);
  eod.writeUInt16LE(0, 6);
  eod.writeUInt16LE(entries.length, 8);
  eod.writeUInt16LE(entries.length, 10);
  eod.writeUInt32LE(cdSize, 12);
  eod.writeUInt32LE(offset, 16);
  eod.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, eod]);
}

// Job workers (ESM, run as worker_threads)

const GREET_JOB = `
import { workerData, parentPort } from 'worker_threads';
const { greeting } = workerData;
parentPort.postMessage({ success: true, outputs: { message: greeting + ' world' } });
`.trim();

// Reads `message` from inherited dep output, appends `suffix`
const APPEND_JOB = `
import { workerData, parentPort } from 'worker_threads';
const { message, suffix } = workerData;
parentPort.postMessage({ success: true, outputs: { result: message + ' ' + (suffix ?? '!') } });
`.trim();

const FAIL_JOB = `
import { workerData, parentPort } from 'worker_threads';
parentPort.postMessage({ success: false, error: 'intentional failure' });
`.trim();

const CACHED_JOB = `
import { parentPort } from 'worker_threads';
globalThis.log('computed');
parentPort.postMessage({ success: true, outputs: { token: crypto.randomUUID() } });
`.trim();

const CREATE_DOCUMENT_WITH_STRING_TITLE_JOB = `
import { parentPort } from 'worker_threads';
const document = await globalThis.createDocument('# Report', 'Workflow Created Title');
parentPort.postMessage({ success: true, outputs: { documentId: document.id } });
`.trim();

function buildTestExtensionZip(): Buffer {
  const manifest = {
    id: "test-workflow-ext",
    name: "Test Workflow Extension",
    version: "1.0.0",
    entries: {},
    jobs: [
      { id: "greet", name: "Greet", entry: "jobs/greet.mjs" },
      { id: "append", name: "Append", entry: "jobs/append.mjs" },
      { id: "fail", name: "Fail", entry: "jobs/fail.mjs" },
      { id: "cached", name: "Cached", entry: "jobs/cached.mjs" },
      {
        id: "create-document-string-title",
        name: "Create Document String Title",
        entry: "jobs/create-document-string-title.mjs",
      },
    ],
  };
  return buildZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "jobs/greet.mjs", data: Buffer.from(GREET_JOB) },
    { name: "jobs/append.mjs", data: Buffer.from(APPEND_JOB) },
    { name: "jobs/fail.mjs", data: Buffer.from(FAIL_JOB) },
    { name: "jobs/cached.mjs", data: Buffer.from(CACHED_JOB) },
    { name: "jobs/create-document-string-title.mjs", data: Buffer.from(CREATE_DOCUMENT_WITH_STRING_TITLE_JOB) },
  ]);
}

// --- HTTP helpers ---

async function api(path: string, options: RequestInit = {}): Promise<Response> {
  const headers = new Headers(options.headers);
  // sessionToken is already the signed+URL-encoded cookie value
  headers.set("Cookie", `better-auth.session_token=${sessionToken}`);
  if (!headers.has("Content-Type") && options.body && typeof options.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${BASE_URL}${path}`, { ...options, headers });
}

async function pollRun(
  spaceId: string,
  runId: string,
  timeoutMs = 15_000,
): Promise<{
  status: string;
  nodes: Record<string, unknown>;
  output: Record<string, unknown> | null;
}> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await api(`/api/v1/spaces/${spaceId}/workflows/runs/${runId}`);
    const body = (await res.json()) as {
      status: string;
      nodes: Record<string, unknown>;
      output: Record<string, unknown> | null;
    };
    if (body.status === "completed" || body.status === "failed") return body;
    await Bun.sleep(25);
  }
  throw new Error(`Run ${runId} did not finish within ${timeoutMs}ms`);
}

async function createWorkflowDoc(definition: object): Promise<string> {
  const res = await api(`/api/v1/spaces/${testSpaceId}/documents`, {
    method: "POST",
    body: JSON.stringify({
      title: "Test Workflow",
      type: "workflow",
      content: JSON.stringify(definition),
    }),
  });
  if (!res.ok) throw new Error(`Failed to create workflow doc: ${await res.text()}`);
  const data = (await res.json()) as { document: { id: string } };
  expect(data.document.id).toStartWith("doc_");
  return data.document.id;
}

/**
 * better-auth signs cookies as: token.base64(hmac-sha256(token, secret))
 * The cookie value is then URL-encoded when sent by the browser.
 * We reconstruct the same signed+encoded value from the raw DB token.
 */
function signSessionToken(token: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${sig}`);
}

function readAuthSecret(): string {
  // .env is in the repo root (one level above app/)
  const env = readFileSync(join("..", ".env"), "utf-8");
  const match = env.match(/^AUTH_SECRET:\s*"(.+)"/m);
  if (!match) throw new Error("AUTH_SECRET not found in .env");
  return match[1];
}

// --- Setup / teardown ---

beforeAll(async () => {
  rmSync(join(tmpdir(), "wiki-job-cache"), { recursive: true, force: true });

  // Pick the most recently updated session that hasn't expired yet
  const db = new Database(join(DATA_DIR, "auth.db"));
  const row = db
    .query<{ token: string }, [number]>(
      "SELECT token FROM session WHERE expires_at > ? ORDER BY updated_at DESC LIMIT 1",
    )
    .get(Date.now() / 1000);
  db.close();

  if (!row)
    throw new Error("No active session found in auth.db — log in to the app first");
  const secret = readAuthSecret();
  sessionToken = signSessionToken(row.token, secret);

  // Create an isolated test space
  const spaceRes = await api("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "WF Test Space", slug: `wf-test-${Date.now()}` }),
  });
  if (!spaceRes.ok) throw new Error(`Space creation failed: ${await spaceRes.text()}`);
  const spaceData = (await spaceRes.json()) as { space: { id: string } };
  testSpaceId = spaceData.space.id;

  // Upload the test extension
  const zip = buildTestExtensionZip();
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([zip], { type: "application/zip" }),
    "test-workflow-ext.zip",
  );
  // Astro's CSRF check compares Origin to the backend host (8080), not the dev server (4321),
  // because the Vite proxy rewrites the Host header via changeOrigin:true.
  const extHeaders = new Headers({
    Cookie: `better-auth.session_token=${sessionToken}`,
    Origin: "http://127.0.0.1:8080",
  });
  const extRes = await fetch(`${BASE_URL}/api/v1/spaces/${testSpaceId}/extensions`, {
    method: "POST",
    headers: extHeaders,
    body: fd,
  });
  if (!extRes.ok) throw new Error(`Extension upload failed: ${await extRes.text()}`);
});

afterAll(async () => {
  if (testSpaceId) {
    rmSync(join(DATA_DIR, "spaces", `${testSpaceId}.db`), { force: true });
  }
});

// --- Tests ---

describe("Workflow runs — single node", () => {
  it("POST returns 202 with runId", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "greet",
        inputs: [{ key: "greeting", value: "hello" }],
        depends: [],
      },
    });

    const res = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { runId: string };
    expect(typeof body.runId).toBe("string");
    expect(body.runId).toStartWith("run_");
  });

  it("run completes with correct job output", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "greet",
        inputs: [{ key: "greeting", value: "hello" }],
        depends: [],
      },
    });
    const { runId } = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);

    const run = await pollRun(testSpaceId, runId);
    expect(run.status).toBe("completed");
    const node = run.nodes["node1"] as { status: string; outputs: { message: string } };
    expect(node.status).toBe("completed");
    expect(node.outputs.message).toBe("hello world");
    expect(run.output).toEqual({ message: "hello world" });
  });
});

describe("Workflow runs — two-node dependency", () => {
  it("passes outputs from node1 into node2 inputs", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "greet",
        inputs: [{ key: "greeting", value: "hi" }],
        depends: [],
      },
      node2: {
        extensionId: "test-workflow-ext",
        jobId: "append",
        inputs: [{ key: "suffix", value: "!!" }],
        depends: ["node1"],
      },
    });
    const { runId } = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);

    const run = await pollRun(testSpaceId, runId);
    expect(run.status).toBe("completed");
    const n2 = run.nodes["node2"] as { status: string; outputs: { result: string } };
    expect(n2.status).toBe("completed");
    // node1 outputs { message: "hi world" }; node2 appends suffix "!!"
    expect(n2.outputs.result).toBe("hi world !!");
    expect(run.output).toEqual({ result: "hi world !!" });
  });

  it("explicit inputs override inherited outputs on key conflict", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "greet",
        inputs: [{ key: "greeting", value: "hello" }],
        depends: [],
      },
      node2: {
        extensionId: "test-workflow-ext",
        jobId: "append",
        // override `message` that would come from node1
        inputs: [
          { key: "message", value: "overridden" },
          { key: "suffix", value: "!" },
        ],
        depends: ["node1"],
      },
    });
    const { runId } = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);

    const run = await pollRun(testSpaceId, runId);
    expect(run.status).toBe("completed");
    const n2 = run.nodes["node2"] as { outputs: { result: string } };
    expect(n2.outputs.result).toBe("overridden !");
    expect(run.output).toEqual({ result: "overridden !" });
  });
});

describe("Workflow runs — document creation", () => {
  it("preserves string titles passed to createDocument helpers", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "create-document-string-title",
        inputs: [],
        depends: [],
      },
    });

    const { runId } = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);

    const run = await pollRun(testSpaceId, runId);
    expect(run.status).toBe("completed");
    const node = run.nodes["node1"] as { outputs: { documentId: string } };

    const createdRes = await api(
      `/api/v1/spaces/${testSpaceId}/documents/${node.outputs.documentId}`,
    );
    expect(createdRes.status).toBe(200);
    const created = (await createdRes.json()) as {
      document: { properties: { title?: string } };
    };
    expect(created.document.properties.title).toBe("Workflow Created Title");
  });
});

describe("Workflow runs — cached reruns", () => {
  it("reuses job outputs when rerun with unchanged inputs", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "cached",
        inputs: [{ key: "stable", value: "clear-cache-inputs" }],
        depends: [],
      },
    });

    const firstRunId = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);
    const firstRun = await pollRun(testSpaceId, firstRunId.runId);

    const secondRunId = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);
    const secondRun = await pollRun(testSpaceId, secondRunId.runId);

    const firstNode = firstRun.nodes["node1"] as {
      status: string;
      outputs: { token: string };
      logs: string[];
    };
    const secondNode = secondRun.nodes["node1"] as {
      status: string;
      outputs: { token: string };
      logs: string[];
    };

    expect(firstNode.status).toBe("completed");
    expect(firstNode.logs).toEqual(["computed"]);
    expect(secondNode.status).toBe("completed");
    expect(secondNode.logs).toEqual([]);
    expect(secondNode.outputs).toEqual(firstNode.outputs);
  });

  it("clears all cached job outputs for a workflow", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "cached",
        inputs: [{ key: "stable", value: "same-inputs" }],
        depends: [],
      },
    });

    const firstRunId = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);
    const firstRun = await pollRun(testSpaceId, firstRunId.runId);
    const firstNode = firstRun.nodes["node1"] as {
      outputs: { token: string };
      logs: string[];
    };

    const clearRes = await api(`/api/v1/spaces/${testSpaceId}/workflows/cache`, {
      method: "DELETE",
      body: JSON.stringify({ documentId: docId }),
    });
    expect(clearRes.status).toBe(200);
    const clearBody = (await clearRes.json()) as { clearedScopes: number };
    expect(clearBody.clearedScopes).toBe(1);

    const secondRunId = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);
    const secondRun = await pollRun(testSpaceId, secondRunId.runId);
    const secondNode = secondRun.nodes["node1"] as {
      outputs: { token: string };
      logs: string[];
    };

    expect(firstNode.logs).toEqual(["computed"]);
    expect(secondNode.logs).toEqual(["computed"]);
    expect(secondNode.outputs.token).not.toBe(firstNode.outputs.token);
  });
});

describe("Workflow runs — failure handling", () => {
  it("marks run as failed when job posts success=false", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "fail",
        inputs: [],
        depends: [],
      },
    });
    const { runId } = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);

    const run = await pollRun(testSpaceId, runId);
    expect(run.status).toBe("failed");
    const node = run.nodes["node1"] as { status: string; error: string };
    expect(node.status).toBe("failed");
    expect(node.error).toContain("intentional failure");
  });
});

describe("Workflow runs — validation errors", () => {
  it("GET unknown runId returns 404", async () => {
    const res = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("POST without documentId returns 400", async () => {
    // Note: sending {} triggers an Astro node-adapter edge-case where an
    // empty-object req.body causes the body stream to be re-read (already consumed
    // by express.json), so we send a non-empty body that simply omits documentId.
    const res = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ unrelated: true }),
    });
    expect(res.status).toBe(400);
  });

  it("POST with non-workflow document returns 400", async () => {
    const docRes = await api(`/api/v1/spaces/${testSpaceId}/documents`, {
      method: "POST",
      body: JSON.stringify({ title: "Plain Doc", content: "<p>hi</p>" }),
    });
    const {
      document: { id },
    } = (await docRes.json()) as { document: { id: string } };

    const res = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: id }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error.toLowerCase()).toContain("workflow");
  });

  it("POST with unknown extensionId returns 400", async () => {
    const docId = await createWorkflowDoc({
      node1: { extensionId: "no-such-ext", jobId: "greet", inputs: [], depends: [] },
    });
    const res = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no-such-ext");
  });

  it("POST with unknown jobId returns 400", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "no-such-job",
        inputs: [],
        depends: [],
      },
    });
    const res = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no-such-job");
  });
});

describe("Workflow runs — source extension filtering", () => {
  it("lists only runs started directly by requested extension", async () => {
    const docId = await createWorkflowDoc({
      node1: {
        extensionId: "test-workflow-ext",
        jobId: "greet",
        inputs: [{ key: "greeting", value: "hello" }],
        depends: [],
      },
    });

    const { runId: empcoRunId } = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({
        documentId: docId,
        sourceExtensionId: "empco-linter",
      }),
    }).then((r) => r.json() as Promise<{ runId: string }>);

    const { runId: plainRunId } = await api(`/api/v1/spaces/${testSpaceId}/workflows/runs`, {
      method: "POST",
      body: JSON.stringify({ documentId: docId }),
    }).then((r) => r.json() as Promise<{ runId: string }>);

    await pollRun(testSpaceId, empcoRunId);
    await pollRun(testSpaceId, plainRunId);

    const res = await api(
      `/api/v1/spaces/${testSpaceId}/workflows/runs?sourceExtensionId=empco-linter`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: { runId: string; sourceExtensionId: string | null }[];
    };

    expect(body.runs.map((run) => run.runId)).toContain(empcoRunId);
    expect(body.runs.map((run) => run.runId)).not.toContain(plainRunId);
    expect(body.runs.every((run) => run.sourceExtensionId === "empco-linter")).toBe(true);
  });
});
