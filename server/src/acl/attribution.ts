/**
 * The attribution of the request being served, read from its verified job token
 * so every audit entry the request writes credits the app without each route
 * passing it along.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { Attribution } from "#acl/apps.ts";

const storage = new AsyncLocalStorage<{ attribution: Attribution | null }>();

/** Run `handler` as one request, with no attribution until a job token supplies one. */
export function withAttributionScope<R>(handler: () => R): R {
  return storage.run({ attribution: null }, handler);
}

/** Records the attribution of a job token the current request was verified with. */
export function noteRequestAttribution(attribution: Attribution): void {
  const scope = storage.getStore();
  if (scope) scope.attribution = attribution;
}

export function currentAttribution(): Attribution | null {
  return storage.getStore()?.attribution ?? null;
}
