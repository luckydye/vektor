import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { canAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { type NodeScreens, nodeRegistry } from "#agent/nodes/registry.ts";
import { config, getLocalOrigin } from "#config";
import { openSpaceStore } from "#db/client/store.ts";
import { listSpaceRunnersWithSecrets } from "#db/space/runners.ts";
import { assertEgressAllowed } from "#jobs/runtime/capabilities.ts";
import type { Platform } from "#platform/platform.ts";
import {
  JOBS_ONLY,
  type RunnerDescription,
  type RunnerHost,
  type RunnerRequest,
} from "./contract.ts";

/**
 * Runners: anything outside this server that runs jobs, and optionally
 * agents, by one contract (docs/runners.md). The server hands a runner a
 * request; while the run goes, the runner POSTs `{ name, args }` calls to
 * `host.url` with `host.token`, and its `result` call ends the run. Every hop
 * is a short request, so no connection has to last as long as the run.
 *
 * Runners are the space's HTTP endpoints (space settings) and nodes
 * (`vektor agent serve`), which get the same requests over their socket.
 */

/** What a runner learns about a run it carries. */
export type RunLink = {
  /** Aborted when the run is cancelled or times out. */
  signal: AbortSignal;
  /** Fails the run: the runner went away with it. */
  lost(error: Error): void;
  /** Settles when the run ends, however it ends. */
  ended: Promise<void>;
};

export type Runner = {
  /** Identifies the runner across runs, for spreading them. */
  key: string;
  name: string;
  description: RunnerDescription;
  /** Agent sessions it holds at once; unbounded when absent. */
  maxSessions?: number;
  /** Hands a request over; resolves once the runner has accepted it. */
  send(request: RunnerRequest, link?: RunLink): Promise<void>;
  /** A node's extension: viewers can open a session's display. */
  screens?: NodeScreens;
};

type LiveRun = {
  token: string;
  runner: string;
  touch(): void;
  finish(result: object): void;
  handle(name: string, args: unknown[]): unknown;
};

const runs = new Map<string, LiveRun>();

/** Where runners call back: the public URL when set, else this process. */
export function callbackOrigin(): string {
  return config().SITE_URL?.trim() || getLocalOrigin();
}

/** Runs `runner` has out. */
export function runsOn(runner: Runner): number {
  let count = 0;
  for (const run of runs.values()) if (run.runner === runner.key) count++;
  return count;
}

/**
 * Hands a run to `runner`; `result` resolves with what its `result` call
 * carried. The deadline is the job VM's kind, an inactivity deadline: every
 * call renews it, so a runner that goes away fails the run once it has been
 * quiet that long.
 */
export function startRun(
  runner: Runner,
  options: {
    request(runId: string, host: RunnerHost): RunnerRequest;
    /** Calls other than `result` and `touch`. */
    handle(name: string, args: unknown[]): unknown;
    timeoutMs: number;
  },
): { result: Promise<object>; touch(): void; cancel(): void } {
  const runId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const controller = new AbortController();
  const finished = Promise.withResolvers<object>();
  const ended = Promise.withResolvers<void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    if (!runs.has(runId)) return;
    clearTimeout(timer);
    timer = setTimeout(
      () => controller.abort(new Error(`timed out after ${options.timeoutMs}ms`)),
      options.timeoutMs,
    );
  };
  controller.signal.addEventListener(
    "abort",
    () => finished.reject(controller.signal.reason),
    { once: true },
  );
  runs.set(runId, {
    token,
    runner: runner.key,
    touch,
    finish: finished.resolve,
    handle: options.handle,
  });
  touch();

  const host = { url: `${callbackOrigin()}/api/v1/runs/${runId}/call`, token };
  // Not awaited: the result may come back before the runner's answer does.
  runner
    .send(options.request(runId, host), {
      signal: controller.signal,
      lost: finished.reject,
      ended: ended.promise,
    })
    .catch(finished.reject);

  const result = finished.promise.finally(() => {
    // The token dies with the run: a runner that keeps going is refused.
    runs.delete(runId);
    clearTimeout(timer);
    ended.resolve();
  });
  return { result, touch, cancel: () => controller.abort(new Error("cancelled")) };
}

/**
 * Answers a runner's call for a live run. Null when the run is over or the
 * token is not its own.
 */
export async function answerRunnerCall(
  runId: string,
  token: string,
  name: string,
  args: unknown[],
): Promise<{ value: unknown } | { error: string } | null> {
  const run = runs.get(runId);
  if (!run) return null;
  const expected = Buffer.from(run.token);
  const given = Buffer.from(token);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;

  run.touch();
  // Keeps a run that works quietly from passing its deadline.
  if (name === "touch") return { value: null };
  if (name === "result") {
    const result = args[0];
    if (typeof result !== "object" || result === null) {
      return { error: "result takes an object" };
    }
    // Only the first counts, so a runner may retry it.
    run.finish(result);
    return { value: null };
  }
  try {
    return { value: (await run.handle(name, args)) ?? null };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    run.touch();
  }
}

function post(
  platform: Platform,
  runner: { url: string; secret: string },
  request: RunnerRequest,
  signal?: AbortSignal,
): Promise<Response> {
  return platform.fetch(
    runner.url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${runner.secret}`,
      },
      body: JSON.stringify(request),
      signal,
    },
    assertEgressAllowed,
  );
}

/**
 * What an HTTP runner offers. One that refuses `describe` runs jobs only;
 * one that cannot be reached throws.
 */
export async function describeRunner(
  platform: Platform,
  runner: { name: string; url: string; secret: string },
): Promise<RunnerDescription> {
  const response = await post(platform, runner, { kind: "describe" });
  if (!response.ok) return JOBS_ONLY;
  const answer = (await response.json().catch(() => ({}))) as Partial<RunnerDescription>;
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const kinds = strings(answer.kinds).filter((k) => k === "job" || k === "agent");
  return { kinds, agents: kinds.includes("agent") ? strings(answer.agents) : [] };
}

/** The space's HTTP runners; requests carry the runner's secret. */
async function httpRunners(platform: Platform, spaceId: string): Promise<Runner[]> {
  const runners = await listSpaceRunnersWithSecrets(
    await openSpaceStore(platform, spaceId),
  );
  return runners.map((runner) => ({
    key: `http:${spaceId}:${runner.id}`,
    name: runner.name,
    description: runner.description,
    async send(request, link) {
      const response = await post(platform, runner, request, link?.signal);
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`Runner "${runner.name}" answered ${response.status}: ${detail}`);
      }
    },
  }));
}

/** Where a run of `userId` may run jobs: the space's runners, its own nodes and shared ones. */
export async function jobRunners(
  platform: Platform,
  scope: { spaceId: string; userId: string | null },
): Promise<Runner[]> {
  return [
    ...nodeRegistry.runners({ ...scope, shared: true }),
    ...(await httpRunners(platform, scope.spaceId)),
  ].filter((runner) => runner.description.kinds.includes("job"));
}

/**
 * Where `userId` may run agents: its own nodes, and the space's runners that
 * offer agents when it owns the space.
 */
export async function agentRunners(
  platform: Platform,
  scope: { spaceId: string; userId: string },
): Promise<Runner[]> {
  const owner = await canAccess(
    platform,
    scope.spaceId,
    { type: ResourceType.SPACE, id: scope.spaceId },
    scope.userId,
    Permission.OWNER,
  );
  return [
    ...nodeRegistry.runners({ ...scope, shared: false }),
    ...(owner ? await httpRunners(platform, scope.spaceId) : []),
  ].filter((runner) => runner.description.agents.length > 0);
}
