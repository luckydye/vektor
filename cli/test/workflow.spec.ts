import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runWorkflowLocally } from "../src/workflow.ts";

const tempPaths: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.push(dir);
  return dir;
}

async function createExtensionDir(): Promise<string> {
  const dir = await createTempDir("wiki-workflow-ext-");
  await mkdir(join(dir, "jobs"), { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "local-test-ext",
      name: "Local Test Extension",
      version: "1.0.0",
      entries: {},
      jobs: [
        { id: "greet", entry: "jobs/greet.mjs" },
        { id: "append", entry: "jobs/append.mjs" },
      ],
    }),
  );
  await writeFile(
    join(dir, "jobs/greet.mjs"),
    `
import { workerData, parentPort } from "node:worker_threads";
globalThis.log("greet");
parentPort.postMessage({
  success: true,
  outputs: {
    message: { type: "text", value: workerData.greeting + " world" },
  },
});
`.trim(),
  );
  await writeFile(
    join(dir, "jobs/append.mjs"),
    `
import { workerData, parentPort } from "node:worker_threads";
parentPort.postMessage({
  type: "result",
  success: true,
  outputs: { result: workerData.message + workerData.suffix },
});
`.trim(),
  );
  return dir;
}

async function createWorkflowFile(): Promise<string> {
  const dir = await createTempDir("wiki-workflow-def-");
  const workflowPath = join(dir, "workflow.json");
  await writeFile(
    workflowPath,
    JSON.stringify({
      first: {
        extensionId: "local-test-ext",
        jobId: "greet",
        inputs: [{ key: "greeting", value: "hello" }],
        depends: [],
      },
      second: {
        extensionId: "local-test-ext",
        jobId: "append",
        inputs: [{ key: "suffix", value: "!" }],
        depends: ["first"],
      },
    }),
  );
  return workflowPath;
}

async function createRuntimeExtensionDir(): Promise<string> {
  const dir = await createTempDir("wiki-workflow-runtime-ext-");
  await mkdir(join(dir, "jobs"), { recursive: true });
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      id: "runtime-test-ext",
      name: "Runtime Test Extension",
      version: "1.0.0",
      entries: {},
      jobs: [
        { id: "create-and-artifact", entry: "jobs/create-and-artifact.mjs" },
        { id: "search-and-secret", entry: "jobs/search-and-secret.mjs" },
      ],
    }),
  );
  await writeFile(
    join(dir, "jobs/create-and-artifact.mjs"),
    `
import { parentPort } from "node:worker_threads";
const created = await createDocument("alpha beta gamma");
await writeDocument(created.id, "alpha beta gamma delta");
const body = await readDocument(created.id);
const artifactUrl = await uploadArtifact("result.txt", body, "text/plain");
parentPort.postMessage({
  type: "result",
  success: true,
  outputs: {
    documentId: { type: "text", value: created.id },
    artifact: { type: "file", url: artifactUrl, name: "result.txt" },
    content: { type: "text", value: body },
  },
});
`.trim(),
  );
  await writeFile(
    join(dir, "jobs/search-and-secret.mjs"),
    `
import { parentPort } from "node:worker_threads";
const results = await searchDocuments("beta", 5);
const secret = await getSecret("WORKFLOW_SECRET");
parentPort.postMessage({
  type: "result",
  success: true,
  outputs: {
    count: { type: "text", value: String(results.length) },
    firstId: { type: "text", value: results[0]?.id ?? "" },
    firstSnippet: { type: "text", value: results[0]?.snippet ?? "" },
    secret: { type: "text", value: secret },
  },
});
`.trim(),
  );
  return dir;
}

async function createRuntimeWorkflowFile(): Promise<string> {
  const dir = await createTempDir("wiki-workflow-runtime-def-");
  const workflowPath = join(dir, "workflow.json");
  await writeFile(
    workflowPath,
    JSON.stringify({
      first: {
        extensionId: "runtime-test-ext",
        jobId: "create-and-artifact",
        inputs: [],
        depends: [],
      },
      second: {
        extensionId: "runtime-test-ext",
        jobId: "search-and-secret",
        inputs: [],
        depends: ["first"],
      },
    }),
  );
  return workflowPath;
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("workflow cli", () => {
  it("parses arguments", () => {
    const options = parseArgs(["./workflow.json", "--extension", "./ext", "--json", "--timeout-ms", "123"]);
    expect(options.json).toBe(true);
    expect(options.timeoutMs).toBe(123);
    expect(options.extensionPaths).toHaveLength(1);
  });

  it("runs a local workflow definition from an extension directory", async () => {
    const extensionPath = await createExtensionDir();
    const workflowPath = await createWorkflowFile();

    const result = await runWorkflowLocally({
      workflowPath,
      extensionPaths: [extensionPath],
      json: true,
      timeoutMs: 5_000,
    });

    expect(result.order).toEqual(["first", "second"]);
    expect(result.nodes.first.status).toBe("completed");
    expect(result.nodes.first.logs).toEqual(["greet"]);
    expect(result.nodes.second.inputs).toEqual({
      message: "hello world",
      suffix: "!",
    });
    expect(result.output).toEqual({ result: "hello world!" });
  });

  it("implements local document, artifact, search, and secret helpers", async () => {
    const previous = process.env.WORKFLOW_SECRET;
    process.env.WORKFLOW_SECRET = "s3cr3t";
    try {
      const extensionPath = await createRuntimeExtensionDir();
      const workflowPath = await createRuntimeWorkflowFile();

      const result = await runWorkflowLocally({
        workflowPath,
        extensionPaths: [extensionPath],
        json: true,
        timeoutMs: 5_000,
      });

      expect(result.nodes.first.status).toBe("completed");
      expect(result.nodes.second.inputs.documentId).toBeString();
      expect(String(result.nodes.second.inputs.artifact)).toStartWith("file://");
      expect(result.output.count).toEqual({ type: "text", value: "1" });
      expect(result.output.firstId).toEqual({
        type: "text",
        value: result.nodes.second.inputs.documentId,
      });
      expect(result.output.firstSnippet).toEqual(
        expect.objectContaining({ type: "text", value: expect.stringContaining("beta") }),
      );
      expect(result.output.secret).toEqual({ type: "text", value: "s3cr3t" });
    } finally {
      if (previous === undefined) delete process.env.WORKFLOW_SECRET;
      else process.env.WORKFLOW_SECRET = previous;
    }
  });
});
