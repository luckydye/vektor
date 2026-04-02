/**
 * Generates an ESM wrapper for sandbox execution.
 *
 * Unlike jobRuntime.ts (which uses worker_threads), this reads workerData
 * from /sandbox/job/data.json and communicates via stdout JSON lines:
 *   {"type":"log","message":"..."}
 *   {"type":"result","success":true,"outputs":{...}}
 *   {"type":"result","success":false,"error":"..."}
 */
export function buildSandboxWrapper(jobFileUrl: string): string {
  return `import { readFile } from "node:fs/promises";

const __wd = JSON.parse(await readFile("/sandbox/job/data.json", "utf-8"));
const { spaceId: __s, apiUrl: __a, jobToken: __t } = __wd;

const __send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");

const __headersWithTrace = (headers) => {
  const merged = new Headers(headers ?? {});
  if (__wd.traceparent) merged.set("traceparent", String(__wd.traceparent));
  if (__wd.tracestate) merged.set("tracestate", String(__wd.tracestate));
  return merged;
};

globalThis.log = (message) => {
  __send({ type: "log", message: String(message) });
};

globalThis.uploadArtifact = async (filename, content, mimeType) => {
  const form = new FormData();
  form.append("file", new Blob([content], { type: mimeType }));
  form.append("filename", filename);
  log("POST " + __a + "/api/v1/spaces/" + __s + "/uploads (" + filename + ")");
  const res = await fetch(__a + "/api/v1/spaces/" + __s + "/uploads", {
    method: "POST",
    headers: __headersWithTrace({
      "Authorization": "Bearer " + __t,
      "X-Job-Token": __t,
      "Origin": __a,
    }),
    body: form,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error("Artifact upload failed (" + res.status + "): " + text);
  }
  return (await res.json()).url;
};

globalThis.readDocument = async (documentId) => {
  const res = await fetch(__a + "/api/v1/spaces/" + __s + "/documents/" + documentId, {
    headers: __headersWithTrace({
      "Authorization": "Bearer " + __t,
      "X-Job-Token": __t,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error("readDocument failed (" + res.status + "): " + text);
  }
  return (await res.json()).document.content;
};

globalThis.writeDocument = async (documentId, content, type) => {
  const contentType =
    type === "csv"
      ? "text/csv; charset=utf-8"
      : type === "app"
        ? "application/vnd.wiki.app+html; charset=utf-8"
        : "text/markdown; charset=utf-8";
  log("PUT " + __a + "/api/v1/spaces/" + __s + "/documents/" + documentId);
  const res = await fetch(__a + "/api/v1/spaces/" + __s + "/documents/" + documentId, {
    method: "PUT",
    headers: __headersWithTrace({
      "Content-Type": contentType,
      "Authorization": "Bearer " + __t,
      "X-Job-Token": __t,
    }),
    body: String(content ?? ""),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error("writeDocument failed (" + res.status + "): " + text);
  }
};

globalThis.createDocument = async (content, options) => {
  log("POST " + __a + "/api/v1/spaces/" + __s + "/documents");
  const headers = __headersWithTrace({
    "Content-Type": "text/markdown; charset=utf-8",
    "Authorization": "Bearer " + __t,
    "X-Job-Token": __t,
  });
  if (options?.title) headers.set("X-Document-Title", String(options.title));
  const res = await fetch(__a + "/api/v1/spaces/" + __s + "/documents", {
    method: "POST",
    headers,
    body: String(content ?? ""),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error("createDocument failed (" + res.status + "): " + text);
  }
  return (await res.json()).document;
};

globalThis.searchDocuments = async (query, limit) => {
  const params = new URLSearchParams({ q: query });
  if (limit != null) params.set("limit", String(limit));
  const res = await fetch(__a + "/api/v1/spaces/" + __s + "/search?" + params.toString(), {
    headers: __headersWithTrace({
      "Authorization": "Bearer " + __t,
      "X-Job-Token": __t,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error("searchDocuments failed (" + res.status + "): " + text);
  }
  return (await res.json()).results;
};

globalThis.getSecret = async (name) => {
  const res = await fetch(
    __a + "/api/v1/spaces/" + __s + "/secrets/" + encodeURIComponent(String(name)),
    {
      headers: __headersWithTrace({
        "Authorization": "Bearer " + __t,
        "X-Job-Token": __t,
      }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error("getSecret failed (" + res.status + "): " + text);
  }
  return (await res.json()).value;
};

try {
  await import(${JSON.stringify(jobFileUrl)});
} catch (err) {
  __send({ type: "result", success: false, error: err?.message ?? String(err) });
  process.exit(1);
}`;
}
