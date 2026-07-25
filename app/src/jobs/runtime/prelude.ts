/**
 * The JS runtime the guest sees inside the VM.
 *
 * This file holds *capabilities* — everything the guest can only do because the
 * host does it on its behalf, built on the single primitive the native VM
 * exposes, `__hostCall(name, ...args) -> Promise`, plus the fire-and-forget
 * `__log`.
 *
 * Platform primitives Boa lacks are deliberately NOT here. `URL`,
 * `URLSearchParams`, `crypto`, `structuredClone`, `TextEncoder`/`TextDecoder`
 * and `btoa`/`atob` are provided by the engine in
 * `native/exec/src/platform.rs`: they mediate no host authority, so they are
 * runtime, not contract — and implementing them in guest JS made them both slow
 * and subtly wrong.
 *
 * Two conventions matter:
 *
 * - **Bytes.** A `Uint8Array` crosses the boundary as a base64 envelope, encoded
 *   in Rust. Guest code just sees a real `Uint8Array`, so nothing here converts.
 * - **Globals.** The prelude and the guest are separate evals, so lexical
 *   bindings from one are not visible in the other. Everything is assigned to
 *   `globalThis` explicitly.
 *
 * Capabilities that take content accept a string *or* a `Uint8Array`, so jobs
 * rarely need to convert by hand. Where they do, `TextEncoder`/`TextDecoder` are
 * backed by native codecs rather than implemented here — see below.
 */
export const PRELUDE = String.raw`
(() => {
  const g = globalThis;
  const call = (name, ...args) => __hostCall(name, ...args);

  // ── logging ────────────────────────────────────────────────────────────────
  const format = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || (value.name + ": " + value.message);
    if (value === undefined) return "undefined";
    if (value === null) return "null";
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    }
    return String(value);
  };
  g.log = (...parts) => { __log(parts.map(format).join(" ")); };
  g.console = { log: g.log, info: g.log, debug: g.log, warn: g.log, error: g.log, trace: g.log };

  // ── timers ─────────────────────────────────────────────────────────────────
  // Timers are host calls, which means a sleeping VM costs nothing and a
  // cancelled run does not wait out its timers.
  let nextTimer = 1;
  const cancelled = new Set();
  g.setTimeout = (fn, ms, ...args) => {
    const id = nextTimer++;
    call("sleep", Math.max(0, Number(ms) || 0)).then(() => {
      if (!cancelled.delete(id)) fn(...args);
    });
    return id;
  };
  g.clearTimeout = (id) => { cancelled.add(id); };
  g.setInterval = () => {
    throw new Error("setInterval is not available; use a loop with await sleep(ms)");
  };
  g.clearInterval = () => {};
  g.sleep = (ms) => call("sleep", Math.max(0, Number(ms) || 0));

  // ── text encoding ──────────────────────────────────────────────────────────
  // Thin wrappers over native codecs. The conversion itself must not happen in
  // guest JS: a per-character loop in the interpreter costs seconds per megabyte,
  // and jobs decode every entry of a downloaded archive.
  g.TextEncoder = class TextEncoder {
    get encoding() { return "utf-8"; }
    encode(input = "") { return __utf8Encode(String(input)); }
  };

  g.TextDecoder = class TextDecoder {
    constructor(encoding = "utf-8") {
      this.encoding = String(encoding).toLowerCase();
      if (this.encoding !== "utf-8" && this.encoding !== "utf8") {
        throw new RangeError("Only utf-8 is supported, got " + encoding);
      }
    }
    decode(bytes) {
      if (bytes == null) return "";
      return __utf8Decode(bytes);
    }
  };

  // btoa/atob are native for the same reasons as the text codecs: a job may
  // base64 an entire file, and the native side enforces the real semantics —
  // these convert binary strings (one byte per code unit), and reject input that
  // is not one rather than silently truncating it.
  g.btoa = (input) => __b64Encode(String(input));
  g.atob = (input) => __b64Decode(String(input));

  // ── fetch ──────────────────────────────────────────────────────────────────
  g.Headers = class Headers {
    constructor(init) {
      this._map = new Map();
      this._setCookies = [];
      if (init instanceof Headers) {
        for (const [k, v] of init._map) this._map.set(k, v);
        this._setCookies = init._setCookies.slice();
      } else if (Array.isArray(init)) {
        for (const [k, v] of init) this.set(k, v);
      } else if (init && typeof init === "object") {
        for (const k of Object.keys(init)) this.set(k, init[k]);
      }
    }
    set(k, v) { this._map.set(String(k).toLowerCase(), String(v)); }
    append(k, v) {
      const key = String(k).toLowerCase();
      if (key === "set-cookie") { this._setCookies.push(String(v)); return; }
      const existing = this._map.get(key);
      this._map.set(key, existing ? existing + ", " + v : String(v));
    }
    get(k) { const v = this._map.get(String(k).toLowerCase()); return v === undefined ? null : v; }
    has(k) { return this._map.has(String(k).toLowerCase()); }
    delete(k) { this._map.delete(String(k).toLowerCase()); }
    getSetCookie() { return this._setCookies.slice(); }
    forEach(fn) { for (const [k, v] of this._map) fn(v, k, this); }
    keys() { return this._map.keys(); }
    values() { return this._map.values(); }
    entries() { return this._map.entries(); }
    [Symbol.iterator]() { return this._map.entries(); }
    toJSON() { return Object.fromEntries(this._map); }
  };

  // The host returns a plain description of the response; the body arrives as
  // bytes exactly once, and the reader methods decode from it.
  const makeResponse = (raw) => {
    const headers = new g.Headers(raw.headers || {});
    for (const cookie of raw.setCookies || []) headers.append("set-cookie", cookie);
    const bytes = raw.body instanceof Uint8Array ? raw.body : new Uint8Array(0);
    let used = false;
    const consume = () => {
      if (used) throw new TypeError("Body has already been consumed");
      used = true;
    };
    return {
      ok: raw.status >= 200 && raw.status < 300,
      status: raw.status,
      statusText: raw.statusText || "",
      redirected: !!raw.redirected,
      url: raw.url || "",
      headers,
      async text() { consume(); return new g.TextDecoder().decode(bytes); },
      async json() { consume(); return JSON.parse(new g.TextDecoder().decode(bytes)); },
      async bytes() { consume(); return bytes; },
      async arrayBuffer() { consume(); return bytes.buffer; },
    };
  };

  g.fetch = async (resource, init) => {
    const url = resource && resource.href ? resource.href : String(resource);
    const options = init || {};
    const headers = {};
    if (options.headers) {
      const h = options.headers instanceof g.Headers ? options.headers : new g.Headers(options.headers);
      h.forEach((v, k) => { headers[k] = v; });
    }
    const raw = await call("fetch", url, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined || options.body === null ? null : options.body,
      redirect: options.redirect || "follow",
    });
    return makeResponse(raw);
  };

  // This instance's own API, authenticated by the host. Job fetch cannot reach
  // loopback, so this is the only way to a local endpoint.
  g.apiFetch = async (path, init) => {
    const options = init || {};
    const headers = {};
    if (options.headers) {
      const h = options.headers instanceof g.Headers ? options.headers : new g.Headers(options.headers);
      h.forEach((v, k) => { headers[k] = v; });
    }
    const raw = await call("apiFetch", String(path), {
      method: options.method || "GET",
      headers,
      body: options.body === undefined || options.body === null ? null : options.body,
    });
    return makeResponse(raw);
  };

  g.agentPrompt = (text) => call("agentPrompt", text);

  // URL, URLSearchParams, crypto, structuredClone, TextEncoder/TextDecoder and
  // btoa/atob are provided by the engine, not here: they are platform primitives
  // Boa lacks, not capabilities. See native/exec/src/platform.rs.
  g.hash = (algorithm, data) => call("hash", algorithm, data);

  // ── a process stub ─────────────────────────────────────────────────────────
  // Bundled npm code routinely reads process.env.NODE_ENV. The env is empty on
  // purpose: host environment variables are not the guest's business, and
  // secrets come from getSecret().
  g.process = {
    env: {},
    argv: [],
    platform: "vektor",
    version: "vektor",
    cwd: () => "/",
    nextTick: (fn, ...args) => { Promise.resolve().then(() => fn(...args)); },
    exit: () => { throw new Error("process.exit is not available in a job"); },
  };

  // ── results ────────────────────────────────────────────────────────────────
  // Workflow scripts return a value; bundled jobs cannot use a top-level return,
  // so they declare their outputs with this instead.
  g.output = (outputs) => call("output", outputs);

  // ── space capabilities ─────────────────────────────────────────────────────
  g.uploadArtifact = (filename, content, mimeType) => call("uploadArtifact", filename, content, mimeType);
  g.readDocument = (documentId) => call("readDocument", documentId);
  g.writeDocument = (documentId, content, type) => call("writeDocument", documentId, content, type);
  g.createDocument = (content, options) => call("createDocument", content, options);
  g.searchDocuments = (query, limit) => call("searchDocuments", query, limit);
  g.getSecret = (name) => call("getSecret", name);
  g.runJob = (extensionId, jobId, inputs) => call("runJob", extensionId, jobId, inputs);

  // ── disk cache, scoped to this job ─────────────────────────────────────────
  g.jobCache = {
    get: (key) => call("cacheGet", key),
    set: (key, value, options) => call("cacheSet", key, value, options),
    delete: (key) => call("cacheDelete", key),
    async remember(key, produce, options) {
      const hit = await g.jobCache.get(key);
      if (hit && hit.hit) return hit.value;
      const value = await produce();
      await g.jobCache.set(key, value, options);
      return value;
    },
  };

  // ── archives and spreadsheets ──────────────────────────────────────────────
  // Host-side because the JS implementations are large bundles and slow to
  // interpret; this keeps jobs small and the parsing at native speed.
  g.zip = {
    read: (bytes) => call("zipRead", bytes),
    write: (entries) => call("zipWrite", entries),
  };
  g.spreadsheet = {
    toRows: (bytes, options) => call("spreadsheetToRows", bytes, options),
  };

  // ── scratch space and tools ────────────────────────────────────────────────
  // Every path is relative to a private per-run directory; absolute paths and
  // traversal are rejected by the host.
  g.scratch = {
    read: (path) => call("scratchRead", path),
    readText: (path) => call("scratchReadText", path),
    write: (path, content) => call("scratchWrite", path, content),
    list: (dir) => call("scratchList", dir),
    remove: (path) => call("scratchRemove", path),
    mkdir: (path) => call("scratchMkdir", path),
  };
  g.exec = (command, args, options) => call("exec", command, args || [], options || {});
})();
`;
