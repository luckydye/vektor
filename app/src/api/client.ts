import { config } from "../config.ts";
import { ApiClient } from "./ApiClient.ts";

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function resolveBrowserBaseUrl(apiUrl: string | undefined): string {
  if (typeof window === "undefined") {
    return apiUrl ?? "";
  }

  if (!apiUrl) {
    return "";
  }

  try {
    const current = new URL(window.location.origin);
    const configured = new URL(apiUrl, window.location.origin);
    const sameProtocol = configured.protocol === current.protocol;
    const samePort = configured.port === current.port;

    if (
      sameProtocol &&
      samePort &&
      isLoopbackHost(configured.hostname) &&
      isLoopbackHost(current.hostname)
    ) {
      return "";
    }

    if (configured.origin === current.origin) {
      return "";
    }

    return configured.origin;
  } catch {
    return apiUrl;
  }
}

function resolveBrowserSocketHost(
  socketHost: string | undefined,
  apiUrl: string | undefined,
): string {
  if (socketHost) {
    return socketHost;
  }

  if (typeof window === "undefined") {
    return "";
  }

  if (apiUrl) {
    try {
      return new URL(apiUrl, window.location.origin).host;
    } catch {
      return window.location.host;
    }
  }

  return window.location.host;
}

/**
 * Default API client instance
 * @example
 * import { api } from "@/api/client";
 * const users = await api.users.get();
 */
export const api = new ApiClient({
  baseUrl: resolveBrowserBaseUrl(config().API_URL),
  socketHost: resolveBrowserSocketHost(
    config().COLLABORATION_HOST,
    config().API_URL,
  ),
});

// @ts-expect-error
globalThis.api = api;

export * from "./ApiClient.ts";
