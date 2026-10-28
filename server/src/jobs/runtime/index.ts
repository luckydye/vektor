/**
 * Runtime selection.
 *
 * There is one runtime today and the whole system talks to it through
 * `JobRuntime`, so swapping in another executor is a change to this function and
 * nothing else. Its VM is the platform's, or a runner runs it: a run's `node`
 * and `VEKTOR_INTEGRATED_RUNNER` choose; isolation is not optional.
 */

import type { JobRuntime } from "./types.ts";
import { createVmRuntime } from "./vm.ts";

export type {
  Capability,
  CapabilityTable,
  JobExecution,
  JobRunContext,
  JobRuntime,
} from "./types.ts";

let cached: JobRuntime | undefined;

/** The runtime every job and workflow script runs in. */
export function getJobRuntime(): JobRuntime {
  cached ??= createVmRuntime();
  return cached;
}

/** Release runtime resources at shutdown. */
export async function disposeJobRuntime(): Promise<void> {
  const runtime = cached;
  cached = undefined;
  await runtime?.dispose?.();
}
