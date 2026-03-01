import { config } from "../config.ts";
import { ApiClient } from "./ApiClient.ts";

/**
 * Default API client instance
 * @example
 * import { api } from "@/api/client";
 * const users = await api.users.get();
 */
export const api = new ApiClient({
  baseUrl: config().API_URL,
  socketHost: config().COLLABORATION_HOST,
});

// @ts-expect-error
globalThis.api = api;

export * from "./ApiClient.ts";
