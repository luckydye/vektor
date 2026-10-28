/**
 * The runner contract (docs/runners.md): the requests the server sends a
 * runner, and what a runner sends back through `host.url`. Jobs are the base;
 * agents are an optional kind a runner offers through `describe`.
 */

/** Where a run's calls go: POST `{ name, args }` with `Authorization: Bearer <token>`. */
export type RunnerHost = { url: string; token: string };

/** A job or workflow script. */
export type JobRequest = {
  kind: "job";
  runId: string;
  /** The body of an async function: it may `await` and `return`, and reads `input`. */
  script: string;
  inputs: Record<string, unknown>;
  /** `JOB_RUNNER`: evaluates to `(host, extra?) => (script, input) => Promise`. */
  prelude: string;
  host: RunnerHost;
};

/** One turn of an agent session. */
export type AgentRequest = {
  kind: "agent";
  runId: string;
  /** Stable across a chat's turns; a runner that keeps the session keeps the conversation. */
  sessionId: string;
  /** Which of the runner's agents, as `describe` named them. */
  agent: string;
  prompt: string;
  /** The Vektor tools, as an MCP server over HTTP acting as the session's user. */
  mcp: { url: string; headers: Record<string, string> };
  host: RunnerHost;
};

/** The session ends; the runner may drop whatever it keeps for it. */
export type AgentCloseRequest = { kind: "agent.close"; sessionId: string };

/** Answered with a {@link RunnerDescription}. */
export type DescribeRequest = { kind: "describe" };

export type RunnerRequest =
  | JobRequest
  | AgentRequest
  | AgentCloseRequest
  | DescribeRequest;

/** What a runner offers. One that does not answer `describe` runs jobs only. */
export type RunnerDescription = { kinds: Array<"job" | "agent">; agents: string[] };

export const JOBS_ONLY: RunnerDescription = { kinds: ["job"], agents: [] };

/** A job's `result` call. */
export type JobResult = { output?: unknown; error?: string };

export type SessionStopReason = "end_turn" | "cancelled" | "error";

/** An agent turn's `result` call. */
export type PromptResult = { stopReason: SessionStopReason; error?: string };
