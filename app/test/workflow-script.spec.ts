/**
 * Integration test for a real workflow script that:
 *   1. Downloads pages from a sitemap URL (https://greentrails.de/de/)
 *   2. Converts each downloaded HTML page to markdown via the workflow-builder extension
 *   3. Asserts the output does not contain HTML tags
 *
 * The test spins up its own isolated server (noAuth + in-memory + unsandboxed jobs)
 * so it can be run standalone without any pre-existing server or data directory.
 *
 * Requires outbound network access.
 *
 * Run standalone:
 *   bun test test/workflow-script.spec.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { join } from "node:path";

const PORT = 7476;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const EXTENSION_ZIP = join(
  import.meta.dir,
  "../../extensions/extensions/workflow-builder/workflow-builder.zip",
);

const WORKFLOW_SCRIPT = `\
// Download pages listed in the sitemap at the given URL
const sitemapResult = await runJob('workflow-builder', 'sitemap-download', { 
  urlKey: 'URL', 
  limit: '2', 
  file: "https://greentrails.de/de/"
});

// Convert each downloaded HTML page to markdown
const mdFiles = await runJob('workflow-builder', 'for-each-file', {
  subJobId: 'convert',
  inputKey: 'content',
  selector: 'body',
  inputFormat: 'html',
  outputFormat: 'markdown',
  file: sitemapResult.file,
});

return { 
  result: mdFiles.result 
};
`;

// ---------------------------------------------------------------------------
// State shared across the describe block
// ---------------------------------------------------------------------------

let serverProcess: ReturnType<typeof Bun.spawn>;
let serverLogs = "";
let spaceId: string;
let workflowDocId: string;

// ---------------------------------------------------------------------------
// Server lifecycle + helpers
// ---------------------------------------------------------------------------

async function waitForServer(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/v1/spaces`);
      if (res.status < 500) return;
    } catch {
      // not ready yet – keep polling
    }
    await Bun.sleep(100);
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}

async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  const res = await fetch(`${BASE_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${options.method ?? "GET"} ${path} → ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

type RunState = {
  status: string;
  output: Record<string, unknown> | null;
  nodes: Record<string, { status: string; error?: string | null; logs?: string[] }>;
};

async function pollRunUntilDone(
  space: string,
  runId: string,
  { timeoutMs = 90_000, pollMs = 1_500 } = {},
): Promise<RunState> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    let run: RunState;
    try {
      run = await apiJson<RunState>(`/api/v1/spaces/${space}/workflows/runs/${runId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isConnErr =
        msg.includes("ConnectionRefused") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("Unable to connect") ||
        (err as NodeJS.ErrnoException).code === "ECONNREFUSED";
      if (isConnErr) {
        const tail = serverLogs.split("\n").slice(-30).join("\n");
        throw new Error(
          `Server crashed while workflow was running.\n\n` +
            `Last server output:\n${tail || "(none)"}`,
        );
      }
      throw err;
    }

    if (run.status !== "pending" && run.status !== "running") {
      return run;
    }
    await Bun.sleep(pollMs);
  }

  throw new Error(`Workflow run ${runId} did not finish within ${timeoutMs / 1000}s`);
}

function summariseFailure(run: RunState): string {
  const lines: string[] = [`status: ${run.status}`];
  for (const [id, node] of Object.entries(run.nodes)) {
    if (node.status === "failed") {
      lines.push(`  node ${id}: ${node.error ?? "(no error message)"}`);
      if (node.logs?.length) lines.push(`  logs: ${node.logs.slice(-5).join(" | ")}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  serverProcess = Bun.spawn(["bun", "./src/server.ts", "--port", String(PORT)], {
    env: {
      ...process.env,
      VEKTOR_NO_AUTH: "1",
      VEKTOR_IN_MEMORY_DB: "1",
      VEKTOR_API_ONLY: "1",
      WIKI_JOB_ALLOW_UNSANDBOXED: "1",
      HOST: "127.0.0.1",
      NODE_ENV: "test",
      WIKI_OTEL_ENABLED: "0",
      // Required to sign job tokens used for sub-job API calls
      AUTH_SECRET: "test-secret-for-workflow-integration-testing",
    },
    stdout: "pipe",
    stderr: "pipe",
    cwd: import.meta.dir + "/..",
  });
  // Collect server output so we can surface it on failure
  (async () => {
    for await (const chunk of serverProcess.stdout) {
      serverLogs += new TextDecoder().decode(chunk);
    }
  })();
  (async () => {
    for await (const chunk of serverProcess.stderr) {
      serverLogs += new TextDecoder().decode(chunk);
    }
  })();

  await waitForServer();

  // Create the test space
  const spaceRes = await apiJson<{ space: { id: string } }>("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Workflow Test Space", slug: "workflow-test" }),
  });
  spaceId = spaceRes.space.id;

  // Upload the workflow-builder extension
  const zipBytes = await Bun.file(EXTENSION_ZIP).arrayBuffer();
  const form = new FormData();
  form.append(
    "file",
    new File([zipBytes], "workflow-builder.zip", { type: "application/zip" }),
  );
  const extRes = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/extensions`, {
    method: "POST",
    body: form,
  });
  if (!extRes.ok) {
    throw new Error(`Extension upload failed ${extRes.status}: ${await extRes.text()}`);
  }

  // Create the workflow document
  const docRes = await apiJson<{ document: { id: string } }>(
    `/api/v1/spaces/${spaceId}/documents`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "workflow",
        content: WORKFLOW_SCRIPT,
        properties: { title: "Sitemap to Markdown" },
      }),
    },
  );
  workflowDocId = docRes.document.id;
}, 30_000);

afterAll(() => {
  serverProcess?.kill();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflow: sitemap download + HTML-to-markdown conversion", () => {
  it("workflow-builder extension is installed in the space", async () => {
    const { extensions } = await apiJson<{ extensions: { id: string }[] }>(
      `/api/v1/spaces/${spaceId}/extensions`,
    );
    const ids = extensions.map((e) => e.id);
    expect(ids).toContain("workflow-builder");
  });

  it("workflow document was created with the correct content", async () => {
    const { document } = await apiJson<{
      document: { id: string; type: string | null; content: string };
    }>(`/api/v1/spaces/${spaceId}/documents/${workflowDocId}`);

    expect(document.id).toBe(workflowDocId);
    expect(document.type).toBe("workflow");
    expect(document.content).toContain("sitemap-download");
    expect(document.content).toContain("for-each-file");
    expect(document.content).toContain("outputFormat: 'markdown'");
  });

  it("runs the workflow, completes successfully, and output contains no HTML tags", async () => {
    // ── 1. Start the run ────────────────────────────────────────────────
    const { runId } = await apiJson<{ runId: string }>(
      `/api/v1/spaces/${spaceId}/workflows/runs`,
      {
        method: "POST",
        body: JSON.stringify({ documentId: workflowDocId }),
      },
    );
    expect(runId).toBeString();
    expect(runId.length).toBeGreaterThan(0);

    // ── 2. Poll until the run settles ───────────────────────────────────
    const run = await pollRunUntilDone(spaceId, runId);

    if (run.status !== "completed") {
      throw new Error(`Workflow ended unexpectedly:\n${summariseFailure(run)}`);
    }
    expect(run.status).toBe("completed");

    // ── 3. Validate the output structure ────────────────────────────────
    // The script returns { result: mdFiles.result } where result is the
    // JSON table produced by for-each-file after running convert on each page.
    const result = run.output?.result;
    expect(result).toBeDefined();
    expect(typeof result).toBe("string");

    const resultStr = result as string;
    expect(resultStr.length).toBeGreaterThan(0);

    // ── 4. Assert: no HTML tags in the output ───────────────────────────
    // After HTML → markdown conversion the output must be free of HTML
    // markup. The pattern matches opening and closing tags for every common
    // block/inline element.
    const HTML_TAG =
      /<\/?(?:html|head|body|div|span|p|a|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|section|article|header|footer|nav|main|aside|figure|figcaption|iframe|form|input|button|select|option|textarea|label|script|style|link|meta|noscript|canvas|svg|video|audio|source|picture|img|br|hr|em|strong|i|b|u|s|del|ins|sub|sup|small|mark|abbr|cite|q|code|pre|blockquote|details|summary)[^>]*>/gi;

    expect(resultStr).not.toMatch(HTML_TAG);
  }, 90_000); // generous timeout for external network fetches + conversion
});
