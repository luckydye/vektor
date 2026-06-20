export interface JsExecGlobals {
  argv: string[];
  cwd: string;
  /** Each entry is [key, value] */
  env: string[][];
  platform: string;
  version: string;
}

export interface JsExecOptions {
  timeoutMs?: number;
  filename?: string;
}

export interface JsExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Synchronous JS evaluation — replaces the QuickJS sync context used by js-exec. */
export function evalJsSync(
  code: string,
  globals: JsExecGlobals,
  options?: JsExecOptions,
): JsExecResult;

// ──────────────────────────────────────────────────────────────────────────────
// Workflow VM — step-driven async JS sandbox
// ──────────────────────────────────────────────────────────────────────────────

export type WorkflowVmEventType =
  | "done"
  | "error"
  | "log"
  | "pending_job"
  | "pending";

export interface WorkflowVmEvent {
  type: WorkflowVmEventType;
  /** Present on "done" */
  output?: Record<string, unknown>;
  /** Present on "error" and "log" */
  message?: string;
  /** Present on "pending_job" — opaque ID for resolve/reject */
  jobId?: string;
  /** Present on "pending_job" */
  extensionId?: string;
  /** Present on "pending_job" — the jobId arg passed to runJob() */
  workflowJobId?: string;
  /** Present on "pending_job" */
  inputs?: Record<string, unknown>;
}

/** Create a workflow VM session. Returns an opaque numeric session ID. */
export function workflowVmCreate(
  code: string,
  inputs: Record<string, unknown>,
): number;

/**
 * Advance the VM by one step.
 *
 * - "log"        → a log() call happened; drain message and call step() again
 * - "pending_job" → runJob() was called; resolve/reject then call step() again
 * - "pending"    → promise still pending; yield to event loop then call step() again
 * - "done"       → script completed; output contains the result
 * - "error"      → script threw; message contains the error
 */
export function workflowVmStep(id: number): WorkflowVmEvent;

/** Resolve a pending runJob with a successful result. */
export function workflowVmResolveJob(
  id: number,
  jobId: string,
  result: Record<string, unknown>,
): void;

/** Reject a pending runJob with an error message. */
export function workflowVmRejectJob(
  id: number,
  jobId: string,
  error: string,
): void;

/** Destroy a workflow VM session and free its resources. */
export function workflowVmDestroy(id: number): void;

