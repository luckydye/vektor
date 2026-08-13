/**
 * An inventory of every server-side `fetch` that is not `safeFetch`.
 *
 * `assertPublicUrl` + a bare `fetch` is shorter to write than `safeFetch`, and it
 * is the combination that produced #50, #51 and #52: the guard sees the first hop
 * and the redirect goes wherever it likes. A reviewer cannot be relied on to spot
 * the shorter form, so a new bare `fetch` in these directories fails this test
 * until someone records why it is safe.
 *
 * Being listed here is not approval — `why` says what makes each one safe, or
 * which issue tracks it if nothing does.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCANNED_DIRS = [
  "src/api",
  "src/agent",
  "src/jobs",
  "src/integrations",
  "src/utils",
];

const ALLOWED: Record<string, { calls: number; why: string }> = {
  "src/utils/ssrf.ts": {
    calls: 2,
    why: "safeFetch itself: the plain and the pinned call it is built from",
  },

  // Targets fixed by deployment config, not reachable by a caller-supplied URL.
  "src/integrations/oauthProviders.ts": {
    calls: 3,
    why: "OAuth token and userinfo endpoints from the provider config",
  },
  "src/api/provider/anthropic.ts": { calls: 2, why: "the Anthropic API" },

  // This instance's own API, which is the point of the call.
  "src/agent/core.ts": {
    calls: 1,
    why: "own API by configured apiUrl, with a job token",
  },
  "src/agent/tools.ts": { calls: 1, why: "own API by configured apiUrl" },
  "src/jobs/runtime/capabilities.ts": {
    calls: 2,
    why: "own API for the space and job-token capabilities; the job `fetch` capability uses safeFetch",
  },
  "src/jobs/runtime/agentCapability.ts": { calls: 1, why: "own API, /api/v1/chat/acp" },

  // Caller-influenced, and guarded by something other than safeFetch.
  "src/api/routes/spaces/integration-proxy.ts": {
    calls: 1,
    why: "URL asserted to match the provider origin, and redirect: manual so the bearer token cannot follow a 3xx (#52)",
  },
  "src/api/routes/url-metadata.ts": {
    calls: 2,
    why: "validates every hop by hand (redirect: manual / error), but does not pin the socket — the DNS-rebinding window is still open here",
  },

  // Not a server-side egress surface.
  "src/api/ApiClient.ts": { calls: 7, why: "browser-side client for our own API" },

  // Known SSRF, tracked and unfixed: the provider baseUrl is operator-supplied
  // and reaches wherever it points.
  "src/api/provider/ollama.ts": { calls: 2, why: "issue #71" },
  "src/api/provider/openaiCompatible.ts": { calls: 2, why: "issue #71" },
  "src/api/routes/chat/completions.ts": { calls: 1, why: "issue #71" },
};

/** Files that take a URL straight from a caller, so nothing but safeFetch will do. */
const MUST_USE_SAFE_FETCH = [
  "src/api/routes/proxy-media.ts",
  "src/agent/commands/curl.ts",
];

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) found.push(path);
  }
  return found;
}

/** Bare `fetch(...)` calls, ignoring `safeFetch`, `x.fetch` and commented-out code. */
function countBareFetches(path: string): number {
  const source = readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const direct = source.match(/(?<![\w.$])fetch\s*\(/g) ?? [];
  const viaGlobal = source.match(/(?:globalThis|window)\s*\.\s*fetch\s*\(/g) ?? [];
  return direct.length + viaGlobal.length;
}

describe("server-side fetch call sites", () => {
  const counted = new Map<string, number>();
  for (const dir of SCANNED_DIRS) {
    for (const file of sourceFiles(dir)) {
      const calls = countBareFetches(file);
      if (calls > 0) counted.set(file, calls);
    }
  }

  it("has no bare fetch that is not accounted for", () => {
    const unlisted = [...counted.keys()].filter((file) => !(file in ALLOWED));
    // Route a caller-supplied URL through `safeFetch` (#utils/ssrf.ts), or add the
    // file to ALLOWED with the reason it cannot reach a caller-chosen host.
    expect(unlisted).toEqual([]);
  });

  it("has no new bare fetch in a file that already had one", () => {
    const changed = [...counted.entries()]
      .filter(([file]) => file in ALLOWED)
      .filter(([file, calls]) => calls !== ALLOWED[file].calls)
      .map(
        ([file, calls]) =>
          `${file}: ${ALLOWED[file].calls} accounted for, found ${calls}`,
      );
    expect(changed).toEqual([]);
  });

  it("keeps the inventory free of entries that no longer exist", () => {
    const stale = Object.keys(ALLOWED).filter((file) => !counted.has(file));
    expect(stale).toEqual([]);
  });

  it.each(MUST_USE_SAFE_FETCH)("%s fetches only through safeFetch", (file) => {
    expect(readFileSync(file, "utf8")).toContain("safeFetch(");
    expect(countBareFetches(file)).toBe(0);
  });
});
