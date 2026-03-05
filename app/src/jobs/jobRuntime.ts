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
const { mkdir, readFile, rm, writeFile } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { createHash } = await import("node:crypto");
const {
  context: __ctx,
  propagation: __prop,
  trace: __trace,
  SpanStatusCode: __SpanStatusCode,
} = await import("@opentelemetry/api");

const __cacheScope = String(__wd.cacheScopeId ?? "unknown-job");
const __cacheDir = join(tmpdir(), "wiki-job-cache", __cacheScope);
const __carrier = {};
if (__wd.traceparent) __carrier.traceparent = __wd.traceparent;
if (__wd.tracestate) __carrier.tracestate = __wd.tracestate;
const __parentCtx = __prop.extract(__ctx.active(), __carrier);
const __tracer = __trace.getTracer("wiki.jobs.worker");

const __cacheFileForKey = async (key) => {
  const hash = createHash("sha256").update(String(key)).digest("hex");
  await mkdir(__cacheDir, { recursive: true });
  return join(__cacheDir, hash + ".json");
};

const __headersWithTrace = (headers) => {
  const merged = new Headers(headers ?? {});
  const traceCarrier = {};
  __prop.inject(__ctx.active(), traceCarrier);
  if (!traceCarrier.traceparent && __wd.traceparent) {
    traceCarrier.traceparent = __wd.traceparent;
  }
  if (!traceCarrier.tracestate && __wd.tracestate) {
    traceCarrier.tracestate = __wd.tracestate;
  }
  if (traceCarrier.traceparent) merged.set("traceparent", String(traceCarrier.traceparent));
  if (traceCarrier.tracestate) merged.set("tracestate", String(traceCarrier.tracestate));
  return merged;
};

const __withSpan = async (name, attributes, fn) => {
  return __tracer.startActiveSpan(name, { attributes }, __parentCtx, async (span) => {
    try {
      const result = await fn();
      span.setStatus({ code: __SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error);
      span.setStatus({
        code: __SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
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

globalThis.uploadArtifact = async (filename, content, mimeType) => {
  return __withSpan(
    "wiki.job.helper.upload_artifact",
    { "wiki.job.filename": String(filename ?? "") },
    async () => {
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
    },
  );
};

globalThis.readDocument = async (documentId) => {
  return __withSpan(
    "wiki.job.helper.read_document",
    { "wiki.document.id": String(documentId ?? "") },
    async () => {
      const res = await fetch(__a + "/api/v1/spaces/" + __s + "/documents/" + documentId, {
        headers: __headersWithTrace({ "X-Job-Token": __t }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => String(res.status));
        throw new Error("readDocument failed (" + res.status + "): " + text);
      }
      return (await res.json()).document.content;
    },
  );
};

globalThis.writeDocument = async (documentId, content) => {
  return __withSpan(
    "wiki.job.helper.write_document",
    { "wiki.document.id": String(documentId ?? "") },
    async () => {
      log("PUT " + __a + "/api/v1/spaces/" + __s + "/documents/" + documentId);
      const res = await fetch(__a + "/api/v1/spaces/" + __s + "/documents/" + documentId, {
        method: "PUT",
        headers: __headersWithTrace({
          "Content-Type": "text/markdown; charset=utf-8",
          "X-Job-Token": __t,
        }),
        body: String(content ?? ""),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => String(res.status));
        throw new Error("writeDocument failed (" + res.status + "): " + text);
      }
    },
  );
};

globalThis.createDocument = async (content) => {
  return __withSpan("wiki.job.helper.create_document", {}, async () => {
    log("POST " + __a + "/api/v1/spaces/" + __s + "/documents");
    const res = await fetch(__a + "/api/v1/spaces/" + __s + "/documents", {
      method: "POST",
      headers: __headersWithTrace({
        "Content-Type": "text/markdown; charset=utf-8",
        "X-Job-Token": __t,
      }),
      body: String(content ?? ""),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => String(res.status));
      throw new Error("createDocument failed (" + res.status + "): " + text);
    }
    return (await res.json()).document;
  });
};

globalThis.searchDocuments = async (query, limit) => {
  return __withSpan(
    "wiki.job.helper.search_documents",
    { "wiki.search.limit": limit == null ? "" : String(limit) },
    async () => {
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
    },
  );
};

globalThis.getSecret = async (name) => {
  return __withSpan("wiki.job.helper.get_secret", {}, async () => {
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
  });
};

await import(${JSON.stringify(jobFileUrl)});`;
}
