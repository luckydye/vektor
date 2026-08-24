/**
 * Integration tests for the job runtime.
 *
 * These exercise the boundary rather than the plumbing: real extension jobs run
 * through the real API, using the capabilities the host actually grants. What
 * makes them worth having is the parts unit tests cannot reach —
 *
 *  - the native helpers (`spreadsheet`, `zip`) that replaced bundled libraries,
 *  - the sandbox boundary: no Node, no host filesystem, no reaching this
 *    instance over loopback,
 *  - the runtime's failure modes: a thrown job, an ungranted capability, a
 *    runaway loop, cancellation.
 *
 * Workflow scripts take arbitrary inline code, so they are the lever for
 * testing guest-level behaviour without packaging a fixture extension.
 *
 * Set VEKTOR_TEST_BINARY=./vektor to run all of this against the compiled
 * binary, which is what ships.
 */

import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeXlsx } from "#utils/xlsx.ts";
import { createZipBuffer } from "#utils/zip.ts";
import {
  createApiRequest,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const PORT = 7488;
const BASE_URL = testBaseUrl(PORT);
const apiRequest = createApiRequest(BASE_URL);

const EXTENSION_ZIP = join(
  import.meta.dirname,
  "../../extensions/extensions/workflow-builder/workflow-builder.zip",
);

let serverProcess: TestServerProcess;
let spaceId: string;

async function apiJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await apiRequest(path, options);
  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} → ${response.status}: ${await response.text()}`,
    );
  }
  return (await response.json()) as T;
}

/** Run one extension job and return its outputs. */
async function runJob(
  jobId: string,
  inputs: Record<string, unknown>,
): Promise<{
  outputs: Record<string, { value?: string; url?: string }>;
  logs: string[];
}> {
  return await apiJson(`/api/v1/spaces/${spaceId}/jobs/run`, {
    method: "POST",
    body: JSON.stringify({ jobId, inputs }),
  });
}

/** Attempt a job run that is expected to fail, returning the error message. */
async function runJobExpectingFailure(
  jobId: string,
  inputs: Record<string, unknown>,
): Promise<string> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/jobs/run`, {
    method: "POST",
    body: JSON.stringify({ jobId, inputs }),
  });
  const body = await response.text();
  if (response.ok) throw new Error(`expected ${jobId} to fail, got: ${body}`);
  return body;
}

/** Upload a file to the space and return its URL. */
async function upload(name: string, bytes: Uint8Array, type: string): Promise<string> {
  const response = await fetch(
    `${BASE_URL}/api/v1/spaces/${spaceId}/uploads?filename=${encodeURIComponent(name)}`,
    {
      method: "POST",
      headers: { "Content-Type": type },
      body: bytes as BlobPart,
    },
  );
  if (!response.ok)
    throw new Error(`upload failed ${response.status}: ${await response.text()}`);
  return ((await response.json()) as { url: string }).url;
}

type RunState = {
  status: string;
  error: string | null;
  logs: string[];
  resultArtifact?: { url: string } | null;
};

/** Run an inline workflow script to completion and return its final state. */
async function runScript(
  code: string,
  options: { inputs?: Record<string, unknown>; cancelAfterMs?: number } = {},
): Promise<RunState> {
  const { document } = await apiJson<{ document: { id: string } }>(
    `/api/v1/spaces/${spaceId}/documents`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "workflow",
        content: code,
        properties: { title: "runtime test" },
      }),
    },
  );

  const { runId } = await apiJson<{ runId: string }>(
    `/api/v1/spaces/${spaceId}/workflows/runs`,
    {
      method: "POST",
      body: JSON.stringify({ documentId: document.id, inputs: options.inputs ?? {} }),
    },
  );

  if (options.cancelAfterMs !== undefined) {
    setTimeout(() => {
      void apiRequest(`/api/v1/spaces/${spaceId}/workflows/runs/${runId}`, {
        method: "DELETE",
      });
    }, options.cancelAfterMs);
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const run = await apiJson<RunState>(
      `/api/v1/spaces/${spaceId}/workflows/runs/${runId}`,
    );
    if (run.status !== "pending" && run.status !== "running") return run;
    await Bun.sleep(150);
  }
  throw new Error("workflow run did not settle within 60s");
}

beforeAll(async () => {
  serverProcess = startTestServer(PORT, {
    VEKTOR_NO_AUTH: "1",
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_API_ONLY: "1",
    AUTH_SECRET: "jobs-runtime-test-secret",
    // Deliberately NOT setting VEKTOR_JOB_FETCH_ALLOW_PRIVATE: the egress tests
    // below depend on the default, which is to refuse the local network.
  });
  await waitForServer(BASE_URL);

  const space = await apiJson<{ space: { id: string } }>("/api/v1/spaces", {
    method: "POST",
    body: JSON.stringify({ name: "Job Runtime Tests", slug: "job-runtime" }),
  });
  spaceId = space.space.id;

  const zipBytes = await Bun.file(EXTENSION_ZIP).arrayBuffer();
  const form = new FormData();
  form.append(
    "file",
    new File([zipBytes], "workflow-builder.zip", { type: "application/zip" }),
  );
  const response = await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/extensions`, {
    method: "POST",
    body: form,
  });
  if (!response.ok) {
    throw new Error(
      `extension upload failed ${response.status}: ${await response.text()}`,
    );
  }
}, 60_000);

afterAll(() => {
  serverProcess?.kill();
});

// ─────────────────────────────────────────────────────────────────────────────
// The job protocol
// ─────────────────────────────────────────────────────────────────────────────

describe("job runtime: protocol", () => {
  it("passes inputs in and takes outputs from output()", async () => {
    const { document } = await apiJson<{ document: { id: string } }>(
      `/api/v1/spaces/${spaceId}/documents`,
      {
        method: "POST",
        body: JSON.stringify({
          type: "markdown",
          content: "# Title\n\nSome body text.",
          properties: { title: "Readable" },
        }),
      },
    );

    const { outputs, logs } = await runJob("read-document", {
      documentId: document.id,
    });

    expect(outputs.content?.value).toContain("Some body text.");
    expect(outputs.documentId?.value).toBe(document.id);
    expect(logs.join("\n")).toContain("Reading document");
  });

  it("streams logs and the result over SSE", async () => {
    const response = await apiRequest(`/api/v1/spaces/${spaceId}/jobs/run`, {
      method: "POST",
      body: JSON.stringify({
        jobId: "http-fetch",
        stream: true,
        inputs: { url: "https://example.com" },
      }),
    });

    expect(response.ok).toBe(true);
    const body = await response.text();
    const events = body
      .split("\n\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; message?: string });

    expect(events.some((event) => event.type === "log")).toBe(true);
    expect(events.some((event) => event.type === "output")).toBe(true);
  }, 30_000);

  it("fails the run when a job throws, surfacing the message", async () => {
    const body = await runJobExpectingFailure("read-document", {});
    expect(body).toContain("Missing required input: documentId");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Native helpers that replaced bundled libraries
// ─────────────────────────────────────────────────────────────────────────────

describe("job runtime: native helpers", () => {
  it("parses a spreadsheet through the host, not a bundled parser", async () => {
    const bytes = writeXlsx([
      {
        name: "Data",
        rows: [
          ["Name", "Amount"],
          ["first", 10],
          ["second", 20],
        ],
      },
    ]);

    const fileUrl = await upload(
      "rows.xlsx",
      bytes,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );

    const { outputs } = await runJob("file-to-json", { file: fileUrl });
    const rows = JSON.parse(outputs.json?.value ?? "[]") as Array<
      Record<string, unknown>
    >;

    expect(rows).toEqual([
      { Name: "first", Amount: 10 },
      { Name: "second", Amount: 20 },
    ]);
    expect(outputs.count?.value).toBe("2");
  }, 30_000);

  it("reads a ZIP archive through the host", async () => {
    const archive = createZipBuffer([
      { name: "a.txt", data: Buffer.from("alpha") },
      { name: "b.txt", data: Buffer.from("beta") },
      // Junk entries the extension filters out.
      { name: "__MACOSX/junk.txt", data: Buffer.from("ignored") },
    ]);
    const fileUrl = await upload(
      "bundle.zip",
      new Uint8Array(archive),
      "application/zip",
    );

    const { outputs } = await runJob("merge-files", {
      file: fileUrl,
      separator: "|",
      filename: "merged.txt",
    });

    // merge-files is line-oriented: every part and the separator end with a
    // newline, so the merged form is not a bare join.
    const merged = await fetch(`${BASE_URL}${outputs.file?.url}`).then((r) => r.text());
    expect(merged).toBe("alpha\n|\nbeta\n");
  }, 30_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// The sandbox boundary
// ─────────────────────────────────────────────────────────────────────────────

describe("job runtime: sandbox boundary", () => {
  it("refuses a fetch aimed at this instance over loopback", async () => {
    const body = await runJobExpectingFailure("http-fetch", {
      url: `http://127.0.0.1:${PORT}/api/v1/spaces`,
    });
    expect(body).toContain("private address");
  });

  it("refuses a fetch aimed at cloud metadata", async () => {
    const body = await runJobExpectingFailure("http-fetch", {
      url: "http://169.254.169.254/latest/meta-data/",
    });
    expect(body).toContain("private address");
  });

  it("grants no capability the host did not hand out", async () => {
    const run = await runScript(
      "await __hostCall('readHostFile', '/etc/passwd'); return {};",
    );

    expect(run.status).toBe("failed");
    expect(run.error).toContain("not available");
  });

  it("has no Node runtime to reach for", async () => {
    const run = await runScript(`
      const missing = ["require", "process.binding", "Bun", "module"].filter((name) => {
        if (name === "process.binding") return typeof process !== "undefined" && !!process.binding;
        return typeof globalThis[name] !== "undefined";
      });
      return { missing: missing.join(",") };
    `);

    expect(run.status).toBe("completed");
    const result = await fetch(`${BASE_URL}${run.resultArtifact?.url}`).then((r) =>
      r.json(),
    );
    expect(result.missing).toBe("");
  });

  it("refuses exec arguments that point outside the scratch directory", async () => {
    // The binary allowlist stops shell injection, but the converters happily
    // take absolute in/out paths, which is a read/write of any tenant's data.
    const run = await runScript(`
      const attempts = [
        ["pandoc", ["/etc/passwd", "-t", "plain"]],
        ["pandoc", ["../../etc/passwd"]],
        ["pandoc", ["-o", "/tmp/escaped.docx", "in.md"]],
        ["pandoc", ["--resource-path=.:/etc", "in.md"]],
        ["pandoc", ["--lua-filter=/etc/passwd", "in.md"]],
        ["pandoc", ["file:///etc/passwd"]],
        ["pandoc", ["file:/etc/passwd"]],
        // The URL parser drops the whitespace and reads the scheme regardless
        // of case, so neither obfuscation reaches the tool.
        ["pandoc", ["  FI\\nLE:///etc/passwd"]],
        ["rsvg-convert", ["-o", "out.png", "smb://attacker/share/x.svg"]],
        ["htmlq", ["@/etc/passwd"]],
      ];
      const errors = [];
      for (const [command, args] of attempts) {
        try {
          await exec(command, args);
          errors.push("allowed: " + command + " " + args.join(" "));
        } catch (error) {
          errors.push(String(error.message || error));
        }
      }
      return { errors };
    `);

    expect(run.status).toBe("completed");
    const result = await fetch(`${BASE_URL}${run.resultArtifact?.url}`).then((r) =>
      r.json(),
    );
    expect(result.errors).toHaveLength(10);
    for (const message of result.errors as string[]) {
      expect(message).toMatch(/names a URL|points outside the scratch directory/);
    }
  });

  it("runs no tool the image does not install", async () => {
    // gs, qpdf and libreoffice were allowlisted but never shipped: surface for
    // nothing, and the worst CVE record of the set.
    const run = await runScript(`
      const errors = [];
      for (const command of ["gs", "qpdf", "libreoffice", "soffice", "sh", "bash"]) {
        try {
          await exec(command, ["--version"]);
          errors.push("allowed: " + command);
        } catch (error) {
          errors.push(String(error.message || error));
        }
      }
      return { errors };
    `);

    expect(run.status).toBe("completed");
    const result = await fetch(`${BASE_URL}${run.resultArtifact?.url}`).then((r) =>
      r.json(),
    );
    expect(result.errors).toHaveLength(6);
    for (const message of result.errors as string[]) {
      expect(message).toContain("is not an allowed tool");
    }
  });

  it("still passes ordinary flags and relative paths through to the tool", async () => {
    // Guards against over-broad confinement: these reach the binary, so the
    // failure is a missing or unhappy converter, never a rejected argument.
    const run = await runScript(`
      await scratch.write("in.html", "<p>hi</p>");
      const errors = [];
      const accepted = [
        ["pandoc", ["-f", "html", "-t", "gfm-raw_html", "--wrap=none"]],
        ["pandoc", ["in.html", "-o", "out.docx", "--lua-filter=f.lua"]],
        // Selectors are arguments too, colons, slashes and all.
        ["htmlq", ["--remove-nodes", 'a:hover, [href^="https://ads"]']],
      ];
      for (const [command, args] of accepted) {
        try {
          await exec(command, args, { stdin: "<p>hi</p>" });
        } catch (error) {
          errors.push(String(error.message || error));
        }
      }
      return { errors };
    `);

    expect(run.status).toBe("completed");
    const result = await fetch(`${BASE_URL}${run.resultArtifact?.url}`).then((r) =>
      r.json(),
    );
    for (const message of result.errors as string[]) {
      expect(message).not.toContain("points outside the scratch directory");
    }
    // Nothing installs the converters in CI, so a clean pass and an ENOENT are
    // both fine here — a rejected argument is not.
    expect(result.errors.length).toBeLessThanOrEqual(3);
  });

  it("exposes an empty environment rather than the host's", async () => {
    const run = await runScript("return { keys: Object.keys(process.env).length };");

    expect(run.status).toBe("completed");
    const result = await fetch(`${BASE_URL}${run.resultArtifact?.url}`).then((r) =>
      r.json(),
    );
    expect(result.keys).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime failure modes
// ─────────────────────────────────────────────────────────────────────────────

describe("job runtime: failure modes", () => {
  it("terminates a runaway loop instead of hanging", async () => {
    const run = await runScript("while (true) {} return {};", {});

    expect(run.status).toBe("failed");
    expect(run.error).toBeTruthy();
  }, 60_000);

  it("cancels a running script and lets it unwind", async () => {
    const run = await runScript(
      "try { await sleep(30000); } finally { log('cleanup ran'); } return {};",
      { cancelAfterMs: 1000 },
    );

    expect(run.status).toBe("cancelled");
    expect(run.logs.join("\n")).toContain("cleanup ran");
  }, 60_000);

  it("keeps serving requests while a script burns CPU on its own thread", async () => {
    const busy = runScript(
      "let x = 0; for (let i = 0; i < 20_000_000; i++) x += i; return { x };",
    );

    // The API must stay responsive throughout; a VM on the main thread would
    // stall these.
    let served = 0;
    while (served < 20) {
      const response = await apiRequest("/api/v1/spaces");
      expect(response.ok).toBe(true);
      served += 1;
    }

    const run = await busy;
    expect(run.status).toBe("completed");
  }, 90_000);
});
