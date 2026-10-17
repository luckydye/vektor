import { DefenseInDepthBox, type SecureFetch } from "just-bash";
import { safeFetch } from "#utils/ssrf.ts";

/**
 * just-bash's network layer (its `curl`), pinned through `safeFetch` like every caller-chosen URL.
 * Host code, so it runs trusted: safeFetch's connect race needs the timers the sandbox blocks.
 */
export const sandboxFetch: SecureFetch = (url, options = {}) =>
  DefenseInDepthBox.runTrustedAsync(async () => {
    const response = await safeFetch(url, {
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
