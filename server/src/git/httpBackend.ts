/**
 * The smart HTTP protocol, served by git's own CGI gateway.
 *
 * `git-http-backend` implements ref advertisement, negotiation, shallow
 * clones, filters and the dumb fallback. Reimplementing any of that would be
 * writing a second git; this module only moves bytes and environment across.
 */

import { basename, dirname, join } from "node:path";
import { gitExecPath } from "./run.ts";

export interface BackendRequest {
  /** Directory holding the bare repository. */
  dir: string;
  /** Path below the repository, e.g. `info/refs` or `git-upload-pack`. */
  path: string;
  method: string;
  query: string;
  headers: Headers;
  body: ReadableStream<Uint8Array> | null;
  /** Who the request authenticated as; set only once authorization passed. */
  remoteUser: string;
}

export interface BackendResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

function environment(
  request: BackendRequest,
  projectRoot: string,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    GIT_PROJECT_ROOT: projectRoot,
    // Access was decided before this process started; the backend has no idea
    // who is asking and must not be left to guess from the filesystem.
    GIT_HTTP_EXPORT_ALL: "1",
    PATH_INFO: `/${basename(request.dir)}/${request.path}`,
    REQUEST_METHOD: request.method,
    QUERY_STRING: request.query,
    REMOTE_USER: request.remoteUser,
  };

  const contentType = request.headers.get("content-type");
  if (contentType) env.CONTENT_TYPE = contentType;
  const contentLength = request.headers.get("content-length");
  if (contentLength) env.CONTENT_LENGTH = contentLength;
  // Git gzips upload-pack request bodies, and the backend inflates them itself
  // — but only if it is told they arrived compressed.
  const encoding = request.headers.get("content-encoding");
  if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
  // Without this the connection silently falls back to protocol v0, losing v2's
  // ref filtering on every fetch.
  const protocol = request.headers.get("git-protocol");
  if (protocol) env.GIT_PROTOCOL = protocol;

  return env;
}

/**
 * Split the CGI header block off the front of `stream`, leaving the rest of the
 * bytes to be streamed on as the response body.
 */
async function readCgiHeaders(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ status: number; headers: Headers; rest: Uint8Array }> {
  let buffered = new Uint8Array(0);
  let split = -1;

  while (split === -1) {
    const { done, value } = await reader.read();
    if (done) break;
    const next = new Uint8Array(buffered.length + value.length);
    next.set(buffered);
    next.set(value, buffered.length);
    buffered = next;
    split = Buffer.from(buffered).indexOf("\r\n\r\n");
  }
  if (split === -1) throw new Error("git-http-backend produced no CGI headers");

  const headers = new Headers();
  let status = 200;
  for (const line of Buffer.from(buffered.subarray(0, split)).toString().split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (name.toLowerCase() === "status") status = Number.parseInt(value, 10) || 200;
    else headers.set(name, value);
  }

  return { status, headers, rest: buffered.subarray(split + 4) };
}

/** Serve one smart HTTP request against an already-authorized repository. */
export async function runHttpBackend(request: BackendRequest): Promise<BackendResponse> {
  const backend = join(await gitExecPath(), "git-http-backend");
  const projectRoot = dirname(request.dir);

  const proc = Bun.spawn([backend], {
    env: environment(request, projectRoot),
    stdin: request.body ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = proc.stdout.getReader();
  const { status, headers, rest } = await readCgiHeaders(reader);

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (rest.length > 0) controller.enqueue(rest);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel() {
      proc.kill();
    },
  });

  return { status, headers, body };
}
