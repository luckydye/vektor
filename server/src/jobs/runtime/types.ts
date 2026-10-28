/** What a job run is given (`executeJob`), and what it hands back. */

import type { Attribution } from "#acl/apps.ts";
import type { Platform } from "#platform/platform.ts";

/** A single host capability. Arguments arrive as the guest passed them. */
export type Capability = (...args: never[]) => unknown;

/**
 * The set of capabilities available to a run. A name absent from the table
 * rejects in the guest, which is what makes the runtime deny-by-default: code
 * can only do what the host explicitly hands it.
 */
export type CapabilityTable = Record<string, Capability>;

export interface JobRunContext {
  /** The target the run's capabilities and VM come from. */
  platform: Platform;
  spaceId: string;
  /** Logical id used for log prefixes and cache scoping. */
  jobId: string;
  /** Whose authority the run acts under; null for system-triggered runs. */
  initiatedByUserId: string | null;
  /** The app credited for what the run does. */
  attribution: Attribution;
  /** Becomes the guest's `input` global. */
  inputs: Record<string, unknown>;
  /**
   * Runs the guest on the runner or node of this name (#runners/jobs.ts)
   * rather than on the server. Without it, it runs on one only when
   * the integrated runner is off (`VEKTOR_INTEGRATED_RUNNER=0`), and then on
   * any the run may use.
   */
  runner?: string;
  onLog: (message: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Capabilities layered on top of the standard table. Workflow scripts add
   * `runJob` this way; nothing else needs it.
   */
  extraCapabilities?: CapabilityTable;
}

/** A job underway. */
export interface JobExecution {
  result: Promise<Record<string, unknown>>;
  /** Renew the inactivity deadline for progress the guest does not log itself. */
  touch(): void;
}
