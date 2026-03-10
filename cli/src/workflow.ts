import { mkdir, mkdtemp, opendir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

type WorkflowInput = { key: string; value: unknown };

type WorkflowDefinition = Record<
  string,
  {
    extensionId: string;
    jobId: string;
    inputs: WorkflowInput[];
    depends: string[];
    disabled?: boolean;
  }
>;

type JobDefinition = {
  id: string;
  entry: string;
};

type ExtensionManifest = {
  id: string;
  name: string;
  version: string;
  entries: Record<string, unknown>;
  jobs?: JobDefinition[];
};

type LoadedExtension = {
  manifest: ExtensionManifest;
  files: Map<string, Buffer>;
};

type NodeRunState = {
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  logs: string[];
  error: string | null;
};

type CliOptions = {
  workflowPath: string;
  extensionPaths: string[];
  json: boolean;
  timeoutMs: number;
};

type LocalRuntimePaths = {
  rootDir: string;
  documentsDir: string;
  artifactsDir: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function usage(): string {
  return [
    "Usage: bun cli/src/workflow.ts <workflow.json> --extension <path> [--extension <path> ...] [--json] [--timeout-ms <ms>]",
    "",
    "Examples:",
    "  bun cli/src/workflow.ts ./workflow.json --extension ./extension",
    "  bun cli/src/workflow.ts ./workflow.json --extension ./ext-a.zip --extension ./ext-b",
  ].join("\n");
}

export function parseArgs(argv: string[]): CliOptions {
  assert(argv.length > 0, usage());
  const workflowPath = resolve(argv[0]);
  const extensionPaths: string[] = [];
  let json = false;
  let timeoutMs = 5 * 60 * 1000;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--extension") {
      const value = argv[index + 1];
      assert(value, "--extension requires a path");
      extensionPaths.push(resolve(value));
      index += 1;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = argv[index + 1];
      assert(value, "--timeout-ms requires a value");
      const parsed = Number(value);
      assert(Number.isInteger(parsed) && parsed > 0, "--timeout-ms must be a positive integer");
      timeoutMs = parsed;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
  }

  assert(extensionPaths.length > 0, "At least one --extension path is required");
  return { workflowPath, extensionPaths, json, timeoutMs };
}

function normaliseZipPath(filePath: string): string {
  const normalised = filePath.replace(/^\.?\//, "").trim();
  assert(normalised !== "", "Zip entry path must not be empty");
  assert(!normalised.includes(".."), `Invalid zip entry path: ${filePath}`);
  return normalised;
}

function parseZip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;

  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) break;

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);
    const fileName = buffer
      .subarray(offset + 30, offset + 30 + fileNameLength)
      .toString("utf-8");
    const dataStart = offset + 30 + fileNameLength + extraFieldLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    let fileData: Buffer;
    if (compressionMethod === 0) fileData = compressedData;
    else if (compressionMethod === 8) fileData = inflateRawSync(compressedData);
    else throw new Error(`Unsupported zip compression method: ${compressionMethod}`);

    if (!fileName.endsWith("/")) {
      files.set(normaliseZipPath(fileName), fileData);
    }

    offset = dataStart + compressedSize;
  }

  return files;
}

async function readDirectoryFiles(
  rootPath: string,
  currentPath: string,
  files: Map<string, Buffer>,
): Promise<void> {
  const directory = await opendir(currentPath);
  for await (const dirent of directory) {
    const entryPath = join(currentPath, dirent.name);
    if (dirent.isDirectory()) {
      await readDirectoryFiles(rootPath, entryPath, files);
      continue;
    }
    if (!dirent.isFile()) continue;
    const relativePath = normaliseZipPath(entryPath.slice(rootPath.length + 1));
    files.set(relativePath, Buffer.from(await readFile(entryPath)));
  }
}

async function loadExtension(extensionPath: string): Promise<LoadedExtension> {
  const file = Bun.file(extensionPath);
  const stats = await file.stat();
  const files = new Map<string, Buffer>();

  if (stats.isDirectory()) {
    await readDirectoryFiles(extensionPath, extensionPath, files);
  } else {
    const zipBuffer = Buffer.from(await file.arrayBuffer());
    for (const [name, data] of parseZip(zipBuffer)) files.set(name, data);
  }

  const manifestBuffer = files.get("manifest.json");
  assert(manifestBuffer, `Extension at ${extensionPath} is missing manifest.json`);
  const manifest = JSON.parse(manifestBuffer.toString("utf-8")) as ExtensionManifest;
  assert(typeof manifest.id === "string" && manifest.id !== "", "Extension manifest is missing id");
  assert(Array.isArray(manifest.jobs), `Extension "${manifest.id}" is missing jobs`);
  return { manifest, files };
}

function getExecutionOrder(definition: WorkflowDefinition): string[] {
  for (const [nodeId, node] of Object.entries(definition)) {
    assert(Array.isArray(node.depends), `Node "${nodeId}" is missing depends`);
    for (const dep of node.depends) {
      assert(definition[dep], `Node "${nodeId}" depends on unknown node "${dep}"`);
    }
  }

  const inDegree = new Map<string, number>();
  const adjacent = new Map<string, string[]>();
  for (const nodeId of Object.keys(definition)) {
    inDegree.set(nodeId, definition[nodeId].depends.length);
    adjacent.set(nodeId, []);
  }
  for (const [nodeId, node] of Object.entries(definition)) {
    for (const dep of node.depends) adjacent.get(dep)?.push(nodeId);
  }

  const queue = [...inDegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId);
  const order: string[] = [];

  while (queue.length > 0) {
    const nodeId = queue.shift();
    assert(nodeId, "Queue underflow");
    order.push(nodeId);
    for (const dependent of adjacent.get(nodeId) ?? []) {
      const degree = inDegree.get(dependent);
      assert(degree !== undefined, `Missing degree for node "${dependent}"`);
      const nextDegree = degree - 1;
      inDegree.set(dependent, nextDegree);
      if (nextDegree === 0) queue.push(dependent);
    }
  }

  assert(order.length === Object.keys(definition).length, "Workflow definition contains a dependency cycle");
  return order;
}

function resolveNodeInputs(
  definition: WorkflowDefinition,
  nodeOutputs: Map<string, Record<string, unknown>>,
  nodeId: string,
): Record<string, unknown> {
  const resolvedInputs: Record<string, unknown> = {};
  for (const depId of definition[nodeId].depends) {
    for (const [key, value] of Object.entries(nodeOutputs.get(depId) ?? {})) {
      const typed = value as { type?: string; url?: string; value?: unknown };
      if (typed.type === "file") resolvedInputs[key] = typed.url;
      else if (typed.type === "text") resolvedInputs[key] = typed.value;
      else resolvedInputs[key] = value;
    }
  }
  for (const { key, value } of definition[nodeId].inputs) {
    if (value !== "") resolvedInputs[key] = value;
  }
  return resolvedInputs;
}

function buildLocalJobWrapper(jobFileUrl: string): string {
  return `const { workerData: __wd, parentPort: __pp } = await import("node:worker_threads");
const { mkdir, readFile, readdir, rm, stat, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { basename, join } = await import("node:path");
const { createHash } = await import("node:crypto");
const { pathToFileURL, fileURLToPath } = await import("node:url");
const { execFile } = await import("node:child_process");
const { promisify } = await import("node:util");

const __execFile = promisify(execFile);

const __cacheScope = String(__wd.cacheScopeId ?? "unknown-job");
const __cacheDir = join(tmpdir(), "wiki-job-cache", __cacheScope);
const __documentsDir = String(__wd.documentsDir);
const __artifactsDir = String(__wd.artifactsDir);
const __env = __wd.env ?? {};

const __cacheFileForKey = async (key) => {
  const hash = createHash("sha256").update(String(key)).digest("hex");
  await mkdir(__cacheDir, { recursive: true });
  return join(__cacheDir, hash + ".json");
};

const __documentPath = (documentId) => {
  const id = String(documentId ?? "").trim();
  if (!id) throw new Error("Document id must not be empty");
  if (id.includes("..")) throw new Error("Invalid document id: " + id);
  return join(__documentsDir, id + ".txt");
};

const __decodeFileUrlIfNeeded = (value) => {
  const raw = String(value ?? "");
  if (!raw.startsWith("file://")) return raw;
  return fileURLToPath(raw);
};

const __artifactPath = (filename) => {
  const name = basename(String(filename ?? "").trim());
  if (!name) throw new Error("Artifact filename must not be empty");
  return join(__artifactsDir, name);
};

const __searchSnippet = (content, query) => {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return "";
  const start = Math.max(0, index - 40);
  const end = Math.min(content.length, index + query.length + 40);
  return content.slice(start, end).replace(/\\s+/g, " ").trim();
};

globalThis.log = (message) => {
  __pp.postMessage({ type: "log", message: String(message) });
};

globalThis.jobCache = {
  get: async (key) => {
    const file = await __cacheFileForKey(key);
    try {
      const raw = await readFile(file, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.expiresAt != null && Date.now() >= Number(parsed.expiresAt)) {
        await rm(file, { force: true });
        return { hit: false, value: null };
      }
      return { hit: true, value: parsed.value ?? null };
    } catch {
      return { hit: false, value: null };
    }
  },
  set: async (key, value, options) => {
    const file = await __cacheFileForKey(key);
    const ttlMs = options?.ttlMs;
    const expiresAt = typeof ttlMs === "number" && ttlMs > 0 ? Date.now() + ttlMs : null;
    await writeFile(file, JSON.stringify({ expiresAt, value }), "utf-8");
  },
  delete: async (key) => {
    const file = await __cacheFileForKey(key);
    await rm(file, { force: true });
  },
  remember: async (key, produce, options) => {
    const cached = await globalThis.jobCache.get(key);
    if (cached.hit) return cached.value;
    const value = await produce();
    await globalThis.jobCache.set(key, value, options);
    return value;
  },
};

globalThis.uploadArtifact = async (filename, content) => {
  await mkdir(__artifactsDir, { recursive: true });
  const artifactPath = __artifactPath(filename);
  const buffer =
    typeof content === "string"
      ? Buffer.from(content)
      : content instanceof Uint8Array
        ? Buffer.from(content)
        : Buffer.from(String(content ?? ""));
  await writeFile(artifactPath, buffer);
  return pathToFileURL(artifactPath).href;
};

globalThis.readDocument = async (documentId) => {
  const documentPath = __decodeFileUrlIfNeeded(documentId);
  const resolvedPath = documentPath.startsWith("/") ? documentPath : __documentPath(documentPath);
  return await readFile(resolvedPath, "utf-8");
};

globalThis.writeDocument = async (documentId, content) => {
  await mkdir(__documentsDir, { recursive: true });
  const documentPath = __decodeFileUrlIfNeeded(documentId);
  const resolvedPath = documentPath.startsWith("/") ? documentPath : __documentPath(documentPath);
  await writeFile(resolvedPath, String(content ?? ""), "utf-8");
};

globalThis.createDocument = async (content) => {
  await mkdir(__documentsDir, { recursive: true });
  const id = crypto.randomUUID();
  const path = __documentPath(id);
  await writeFile(path, String(content ?? ""), "utf-8");
  return { id };
};

globalThis.searchDocuments = async (query, limit) => {
  await mkdir(__documentsDir, { recursive: true });
  const files = (await readdir(__documentsDir)).filter((file) => file.endsWith(".txt"));
  if (files.length === 0) return [];

  const maxResults = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Number(limit) : 10;
  let matchedFiles = new Set();
  try {
    const args = ["-l", "--fixed-strings", "--ignore-case", String(query), ...files];
    const { stdout } = await __execFile("rg", args, { cwd: __documentsDir });
    matchedFiles = new Set(
      stdout
        .split("\\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
  } catch (error) {
    const code = error?.code;
    if (code !== 1) throw error;
  }

  const results = [];
  for (const file of files) {
    if (!matchedFiles.has(file)) continue;
    const content = await readFile(join(__documentsDir, file), "utf-8");
    const id = file.slice(0, -4);
    results.push({
      id,
      slug: id,
      snippet: __searchSnippet(content, String(query)),
      rank: 1,
    });
    if (results.length >= maxResults) break;
  }
  return results;
};

globalThis.getSecret = async (name) => {
  const key = String(name ?? "");
  if (!(key in __env)) throw new Error("Secret not found: " + key);
  return __env[key];
};

await import(${JSON.stringify(jobFileUrl)});`;
}

async function runLocalJob(
  extension: LoadedExtension,
  job: JobDefinition,
  inputs: Record<string, unknown>,
  timeoutMs: number,
  runtimePaths: LocalRuntimePaths,
  onLog: (message: string) => void,
): Promise<Record<string, unknown>> {
  const entryPath = normaliseZipPath(job.entry);
  const entryBuffer = extension.files.get(entryPath);
  assert(entryBuffer, `Job entry "${entryPath}" not found in extension "${extension.manifest.id}"`);

  const tempRoot = await mkdtemp(join(tmpdir(), "wiki-workflow-cli-"));
  const jobPath = join(tempRoot, entryPath);
  const wrapperPath = join(tempRoot, "__wrapper__.mjs");

  try {
    await mkdir(dirname(jobPath), { recursive: true });
    await writeFile(jobPath, entryBuffer);
    await writeFile(wrapperPath, buildLocalJobWrapper(pathToFileURL(jobPath).href));

    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      const worker = new Worker(wrapperPath, {
        workerData: {
          ...inputs,
          cacheScopeId: `${extension.manifest.id}:${job.id}`,
          documentsDir: runtimePaths.documentsDir,
          artifactsDir: runtimePaths.artifactsDir,
          env: process.env,
        },
      });
      let settled = false;

      const timer = setTimeout(() => {
        void worker.terminate();
        fail(new Error(`Job "${job.id}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };

      const succeed = (outputs: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outputs);
      };

      worker.once("error", (error) => {
        fail(error);
      });

      worker.on("message", (message) => {
        if (message?.type === "log") {
          onLog(String(message.message ?? ""));
          return;
        }

        if (message?.type === "result" || typeof message?.success === "boolean") {
          void worker.terminate();
          if (message.success) {
            succeed((message.outputs ?? {}) as Record<string, unknown>);
            return;
          }
          fail(new Error(String(message.error ?? `Job "${job.id}" failed`)));
        }
      });

      worker.once("exit", (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error(`Job "${job.id}" exited with code ${code}`));
          return;
        }
        fail(new Error(`Job "${job.id}" exited without sending a result`));
      });
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export async function runWorkflowLocally(options: CliOptions): Promise<{
  order: string[];
  nodes: Record<string, NodeRunState>;
  output: Record<string, unknown>;
}> {
  const workflowText = await readFile(options.workflowPath, "utf-8");
  const definition = JSON.parse(workflowText) as WorkflowDefinition;
  const order = getExecutionOrder(definition);
  const loadedExtensions = new Map<string, LoadedExtension>();

  for (const extensionPath of options.extensionPaths) {
    const extension = await loadExtension(extensionPath);
    assert(
      !loadedExtensions.has(extension.manifest.id),
      `Duplicate extension id "${extension.manifest.id}" provided`,
    );
    loadedExtensions.set(extension.manifest.id, extension);
  }

  const nodes = Object.fromEntries(
    order.map((nodeId) => [
      nodeId,
      { status: "pending", inputs: {}, outputs: null, logs: [], error: null } satisfies NodeRunState,
    ]),
  ) as Record<string, NodeRunState>;

  const nodeOutputs = new Map<string, Record<string, unknown>>();
  const runtimeRoot = await mkdtemp(join(tmpdir(), "wiki-workflow-runtime-"));
  const runtimePaths = {
    rootDir: runtimeRoot,
    documentsDir: join(runtimeRoot, "documents"),
    artifactsDir: join(runtimeRoot, "artifacts"),
  } satisfies LocalRuntimePaths;

  try {
    await mkdir(runtimePaths.documentsDir, { recursive: true });
    await mkdir(runtimePaths.artifactsDir, { recursive: true });

    for (const nodeId of order) {
      const node = definition[nodeId];
      const state = nodes[nodeId];

      if (node.disabled) {
        state.status = "skipped";
        nodeOutputs.set(nodeId, {});
        continue;
      }

      const extension = loadedExtensions.get(node.extensionId);
      assert(extension, `Extension "${node.extensionId}" required by node "${nodeId}" was not provided`);
      const job = extension.manifest.jobs?.find((item) => item.id === node.jobId);
      assert(job, `Job "${node.jobId}" not found in extension "${node.extensionId}"`);

      const resolvedInputs = resolveNodeInputs(definition, nodeOutputs, nodeId);
      state.inputs = resolvedInputs;
      state.status = "running";

      try {
        const outputs = await runLocalJob(
          extension,
          job,
          resolvedInputs,
          options.timeoutMs,
          runtimePaths,
          (message) => {
            state.logs.push(message);
            if (!options.json) process.stderr.write(`[${nodeId}] ${message}\n`);
          },
        );
        state.outputs = outputs;
        state.status = "completed";
        nodeOutputs.set(nodeId, outputs);
      } catch (error) {
        state.status = "failed";
        state.error = error instanceof Error ? error.message : String(error);
        throw new Error(`Node "${nodeId}" failed: ${state.error}`);
      }
    }
  } finally {
    await rm(runtimePaths.rootDir, { recursive: true, force: true });
  }

  const terminalNodeIds = order.filter(
    (nodeId) => !Object.values(definition).some((node) => node.depends.includes(nodeId)),
  );
  const output = Object.assign({}, ...terminalNodeIds.map((nodeId) => nodeOutputs.get(nodeId) ?? {}));
  return { order, nodes, output };
}

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  const result = await runWorkflowLocally(options);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Workflow: ${options.workflowPath}\n`);
  process.stdout.write(`Order: ${result.order.join(" -> ")}\n`);
  for (const nodeId of result.order) {
    const node = result.nodes[nodeId];
    process.stdout.write(`${nodeId}: ${node.status}\n`);
    if (node.outputs) process.stdout.write(`${JSON.stringify(node.outputs)}\n`);
  }
  process.stdout.write(`Output: ${JSON.stringify(result.output, null, 2)}\n`);
}

if (import.meta.main) {
  await main();
}
