import { DefenseInDepthBox, type SecureFetch } from "just-bash";
import type { SafeFetch } from "#utils/ssrf.ts";

/**
 * just-bash's network layer (its `curl`), through the SSRF-safe `fetch` like every caller-chosen URL.
 * Host code, so it runs trusted: the pinned connect race needs the timers the sandbox blocks.
 */
export const createSandboxFetch =
  (fetch: SafeFetch): SecureFetch =>
  (url, options = {}) =>
    DefenseInDepthBox.runTrustedAsync(async () => {
      const response = await fetch(url, {
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
        redirect: options.followRedirects === false ? "manual" : "follow",
        signal: options.timeoutMs ? AbortSignal.timeout(options.timeoutMs) : undefined,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
        body: new Uint8Array(await response.arrayBuffer()),
        url: response.url || url,
      };
    });
