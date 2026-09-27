/**
 * Runtime selection.
 *
 * There is one runtime today and the whole system talks to it through
 * `JobRuntime`, so swapping in another executor is a change to this function and
 * nothing else. `VEKTOR_JOB_RUNTIME` exists to name that choice explicitly
 * rather than to configure isolation: isolation is no longer optional, and there
 * is no unsandboxed path to fall back to.
 */

import { config } from "#config";
import { createBoaRuntime } from "./boa.ts";
import type { JobRuntime } from "./types.ts";

export type { Capability, CapabilityTable, JobRunContext, JobRuntime } from "./types.ts";

let cached: JobRuntime | undefined;

/** The runtime every job and workflow script runs in. */
export function getJobRuntime(): JobRuntime {
  const requested = config().JOB_RUNTIME?.trim() || "boa";
  if (requested !== "boa") {
    throw new Error(`Unknown job runtime "${requested}". Supported values: boa.`);
  }
  cached ??= createBoaRuntime();
  return cached;
}

/** Release runtime resources at shutdown. */
export async function disposeJobRuntime(): Promise<void> {
  const runtime = cached;
  cached = undefined;
  await runtime?.dispose?.();
}
