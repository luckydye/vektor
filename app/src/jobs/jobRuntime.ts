/**
 * Generates the ESM wrapper source that is prepended to every job worker.
 *
 * The wrapper:
 *  1. Reads spaceId / apiUrl / jobToken from workerData (already set by scheduler)
 *  2. Installs globalThis.uploadArtifact (and any future helpers)
 *  3. Dynamically imports the actual job file so the job's own static imports work normally
 *
 * Jobs access the helpers as plain globals — no import required:
 *
 *   const url = await uploadArtifact("report.csv", csvContent, "text/csv");
 */
export function buildJobWrapper(jobFileUrl: string): string {
  return `const { workerData: __wd, parentPort: __pp } = await import("node:worker_threads");
const { spaceId: __s, apiUrl: __a, jobToken: __t } = __wd;

const __headersWithTrace = (headers) => {
  const merged = new Headers(headers ?? {});
  if (__wd.traceparent) merged.set("traceparent", String(__wd.traceparent));
  if (__wd.tracestate) merged.set("tracestate", String(__wd.tracestate));
  return merged;
};

globalThis.log = (message) => {
  __pp.postMessage({ type: "log", message: String(message) });
};

globalThis.uploadArtifact = async (filename, content, mimeType) => {
  const form = new FormData();
  form.append("file", new Blob([content], { type: mimeType }));
  form.append("filename", filename);
  log("POST " + __a + "/api/v1/spaces/" + __s + "/uploads (" + filename + ")");
  const res = await fetch(__a + "/api/v1/spaces/" + __s + "/uploads", {
    method: "POST",
    headers: __headersWithTrace({
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
    headers: __headersWithTrace({ "X-Job-Token": __t }),
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
    "X-Job-Token": __t,
  });
  const title =
    typeof options === "string"
      ? options
      : options && typeof options === "object"
        ? options.title
        : undefined;
  if (title) headers.set("X-Document-Title", String(title));
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
    headers: __headersWithTrace({ "X-Job-Token": __t }),
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
      headers: __headersWithTrace({ "X-Job-Token": __t }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => String(res.status));
    throw new Error("getSecret failed (" + res.status + "): " + text);
  }
  return (await res.json()).value;
};

__pp.on("message", (msg) => { if (msg?.type === "cancel") process.exit(0); });
await import(${JSON.stringify(jobFileUrl)});`;
}
