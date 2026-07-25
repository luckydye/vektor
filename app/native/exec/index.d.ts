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

/** Synchronous JS evaluation, used by the `js-exec` CLI. Blocks the caller. */
export function evalJsSync(
  code: string,
  globals: JsExecGlobals,
  options?: JsExecOptions,
): JsExecResult;

// ──────────────────────────────────────────────────────────────────────────────
// JS VM — the runtime for extension jobs and workflow scripts
// ──────────────────────────────────────────────────────────────────────────────

export interface VmOptions {
  /** Wall-clock ceiling for the whole run. Default 15 minutes. */
  timeoutMs?: number;
  /** Loop iterations allowed per call frame; bounds runaway loops. Default 50M. */
  loopIterationLimit?: number;
  /** Stack for the VM thread, in MiB. Default 16. */
  stackSizeMb?: number;
}

export type VmEventType = "log" | "call" | "done" | "error";

export interface VmEvent {
  type: VmEventType;
  /** Present on "call" — pass back to vmResolve/vmReject. */
  callId?: string;
  /** Present on "call" — the capability name. */
  name?: string;
  /** Present on "call" — the positional arguments. */
  args?: unknown[];
  /** Present on "log" and "error". */
  message?: string;
  /** Present on "done" — the script's return value. */
  output?: unknown;
}

/**
 * Start a VM on its own OS thread and return its session id.
 *
 * `onEvent` fires on the JS thread for each event, in order, and exactly one
 * terminal `done`/`error` event is delivered. Guest code never runs on the JS
 * thread, so a CPU-bound job cannot stall the event loop.
 *
 * Guest code reaches the host through a single primitive, `__hostCall(name,
 * ...args) -> Promise`; `prelude` is evaluated first at global scope and is where
 * the capability globals are built on top of it.
 */
export function vmCreate(
  prelude: string,
  code: string,
  inputs: Record<string, unknown>,
  options: VmOptions | undefined | null,
  onEvent: (event: VmEvent) => void,
): number;

/** Resolve a pending host call. Unknown ids are ignored. */
export function vmResolve(id: number, callId: string, value: unknown): void;

/** Reject a pending host call; guest code sees a thrown Error. */
export function vmReject(id: number, callId: string, message: string): void;

/**
 * Ask a VM to stop. In-flight calls reject with "cancelled" so the script can
 * unwind through its own `finally` blocks, then the run ends with an error event.
 */
export function vmDestroy(id: number): void;
