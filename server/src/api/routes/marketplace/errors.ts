import { errorResponse } from "#api/http.ts";
import { RegistryError } from "#extensions/registry.ts";

/**
 * Turn a registry failure into a response. A `RegistryError` already carries a
 * message meant for a user and the status that fits it — an unreachable store is
 * a 502, an unknown extension a 404 — so it is passed through; anything else is
 * ours and stays opaque.
 */
export function registryErrorResponse(error: unknown): Response {
  if (error instanceof RegistryError) {
    return errorResponse(error.message, error.status);
  }
  throw error;
}
