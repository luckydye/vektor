/**
 * The contract between "what should run" and "what runs it".
 *
 * Vektor ships one implementation (`boaRuntime`, backed by the native Boa VM),
 * but everything above this file — the scheduler, the workflow driver, the job
 * API route — talks only to `JobRuntime`. Plugging in another executor means
 * implementing this interface and returning it from `resolveJobRuntime()`.
 */

/** A single host capability. Arguments arrive as the guest passed them. */
export type Capability = (...args: never[]) => unknown;

/**
 * The set of capabilities available to a run. A name absent from the table
 * rejects in the guest, which is what makes the runtime deny-by-default: code
 * can only do what the host explicitly hands it.
 */
export type CapabilityTable = Record<string, Capability>;

export interface JobRunContext {
  spaceId: string;
  /** Logical id used for log prefixes and cache scoping. */
  jobId: string;
  /** Whose authority the run acts under; null for system-triggered runs. */
  initiatedByUserId: string | null;
  /** Becomes the guest's `input` global. */
  inputs: Record<string, unknown>;
  onLog: (message: string) => void;
  /** Provides a way for the host to renew this run's inactivity deadline. */
  onVmReady?: (touch: () => void) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Capabilities layered on top of the standard table. Workflow scripts add
   * `runJob` this way; nothing else needs it.
   */
  extraCapabilities?: CapabilityTable;
}

export interface JobRuntime {
  /** Identifies the runtime in logs and error messages. */
  readonly name: string;

  /**
   * Run `code` to completion and resolve with its return value.
   *
   * Rejects if the code throws, the deadline passes, or the run is cancelled via
   * `context.signal`. Implementations must not execute guest code on the main
   * thread.
   */
  execute(code: string, context: JobRunContext): Promise<Record<string, unknown>>;

  /** Release any process-level resources. Called once at shutdown. */
  dispose?(): Promise<void>;
}
