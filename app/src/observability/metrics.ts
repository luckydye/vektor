/**
 * Lightweight in-process metrics for operational visibility. Deliberately
 * dependency-free: counters and gauges are updated from hot paths (HTTP
 * middleware, WebSocket lifecycle) and rendered on demand at `/metrics`.
 *
 * The output uses the Prometheus text exposition format so it can be scraped
 * directly by Prometheus/Grafana or read by hand during debugging.
 */

import { eq, sql } from "drizzle-orm";
import { getAuthDb } from "#db/connection.ts";
import { spaceIndex, user } from "#db/schema/auth.ts";
import { activeRuns } from "#jobs/runStore.ts";
import { getJobQueueStats } from "#jobs/scheduler.ts";

/** Rolling window, in seconds, used to compute the HTTP request rate. */
const REQUEST_RATE_WINDOW_SECONDS = 60;

let httpRequestsTotal = 0;

// One count per second in a fixed-size ring. `bucketSeconds` records which
// wall-clock second each slot currently represents so stale slots (older than
// the window) are ignored instead of being cleared eagerly.
const requestBuckets = new Array<number>(REQUEST_RATE_WINDOW_SECONDS).fill(0);
const requestBucketSeconds = new Array<number>(REQUEST_RATE_WINDOW_SECONDS).fill(-1);

let activeWebSocketConnections = 0;

function currentSecond(): number {
  return Math.floor(Date.now() / 1000);
}

/** Records a single served HTTP request for the total counter and rate window. */
export function recordHttpRequest(): void {
  httpRequestsTotal += 1;

  const second = currentSecond();
  const index = second % REQUEST_RATE_WINDOW_SECONDS;
  if (requestBucketSeconds[index] !== second) {
    requestBucketSeconds[index] = second;
    requestBuckets[index] = 0;
  }
  requestBuckets[index] += 1;
}

/** Average requests per second over the rolling window. */
function httpRequestsPerSecond(): number {
  const now = currentSecond();
  let sum = 0;
  for (let i = 0; i < REQUEST_RATE_WINDOW_SECONDS; i += 1) {
    const second = requestBucketSeconds[i];
    if (second >= 0 && now - second < REQUEST_RATE_WINDOW_SECONDS) {
      sum += requestBuckets[i];
    }
  }
  return sum / REQUEST_RATE_WINDOW_SECONDS;
}

/** Marks a WebSocket connection as established. */
export function incrementWebSocketConnections(): void {
  activeWebSocketConnections += 1;
}

/** Marks a WebSocket connection as closed. */
export function decrementWebSocketConnections(): void {
  activeWebSocketConnections = Math.max(0, activeWebSocketConnections - 1);
}

// ---------------------------------------------------------------------------
// CPU + event-loop monitoring
//
// These catch the failure mode where a single request performs heavy
// synchronous work (e.g. compressing/serializing a tens-of-MB document) and
// blocks Bun's single event-loop thread, stalling *every* connected client.
//
//  - Event-loop delay measures how late a fixed-interval timer fires. While the
//    loop is blocked the timer can't run, so when it finally does, the overage
//    equals the stall duration. A multi-second value here is the smoking gun
//    for that class of bug.
//  - CPU utilization (rolling) and the cumulative CPU-time counters surface
//    sustained heavy load, whether from one hot request or aggregate traffic.
// ---------------------------------------------------------------------------

const MONITOR_INTERVAL_MS = 500;
const MONITOR_WINDOW_SECONDS = 60;
const MONITOR_SAMPLES = Math.ceil((MONITOR_WINDOW_SECONDS * 1000) / MONITOR_INTERVAL_MS);

let eventLoopDelayLastMs = 0;

// Ring buffers of per-tick deltas so utilization and peak delay are averaged /
// maxed over a rolling window instead of since process start.
const cpuMicrosDeltas = new Array<number>(MONITOR_SAMPLES).fill(0);
const wallMsDeltas = new Array<number>(MONITOR_SAMPLES).fill(0);
const eventLoopDelaysMs = new Array<number>(MONITOR_SAMPLES).fill(0);
let sampleIndex = 0;
let samplesFilled = 0;

let lastSampleWallMs = performance.now();
let lastCpu = process.cpuUsage();

function sampleMonitor(): void {
  const nowWall = performance.now();
  const wallDelta = nowWall - lastSampleWallMs;
  lastSampleWallMs = nowWall;

  // Anything beyond the scheduled interval is time the loop wasn't free to run
  // this timer — i.e. event-loop delay.
  const delay = Math.max(0, wallDelta - MONITOR_INTERVAL_MS);
  eventLoopDelayLastMs = delay;

  const cpu = process.cpuUsage();
  const cpuDelta = cpu.user + cpu.system - (lastCpu.user + lastCpu.system);
  lastCpu = cpu;

  cpuMicrosDeltas[sampleIndex] = cpuDelta;
  wallMsDeltas[sampleIndex] = wallDelta;
  eventLoopDelaysMs[sampleIndex] = delay;
  sampleIndex = (sampleIndex + 1) % MONITOR_SAMPLES;
  samplesFilled = Math.min(samplesFilled + 1, MONITOR_SAMPLES);
}

// Sampled on a background timer. `unref` keeps it from holding the process open
// (e.g. in tests or during graceful shutdown).
const monitorTimer = setInterval(sampleMonitor, MONITOR_INTERVAL_MS);
monitorTimer.unref?.();

/** Peak event-loop delay, in seconds, over the rolling window. */
function rollingEventLoopDelayMaxSeconds(): number {
  let maxMs = 0;
  for (let i = 0; i < samplesFilled; i += 1) {
    if (eventLoopDelaysMs[i] > maxMs) maxMs = eventLoopDelaysMs[i];
  }
  return maxMs / 1000;
}

/**
 * Fraction of a single CPU core used over the rolling window. On the
 * single-threaded loop, values approaching 1.0 mean it is CPU-saturated;
 * values above 1.0 come from work offloaded to the threadpool (native modules,
 * async zlib, etc.).
 */
function rollingCpuUtilizationRatio(): number {
  let cpuMicros = 0;
  let wallMs = 0;
  for (let i = 0; i < samplesFilled; i += 1) {
    cpuMicros += cpuMicrosDeltas[i];
    wallMs += wallMsDeltas[i];
  }
  if (wallMs <= 0) return 0;
  return cpuMicros / 1000 / wallMs;
}

// ---------------------------------------------------------------------------
// Tenancy counts
//
// Sourced from the auth database's index tables rather than in-memory state so
// they stay accurate across restarts and multiple app instances. Only "active"
// spaces are counted; provisioning/deleted index rows are excluded.
// ---------------------------------------------------------------------------

/** Number of active spaces registered in the space index. */
async function activeSpaceCount(): Promise<number> {
  const row = await getAuthDb()
    .select({ total: sql<number>`count(*)` })
    .from(spaceIndex)
    .where(eq(spaceIndex.status, "active"))
    .get();
  return row?.total ?? 0;
}

/** Number of registered users. */
async function userCount(): Promise<number> {
  const row = await getAuthDb().select({ total: sql<number>`count(*)` }).from(user).get();
  return row?.total ?? 0;
}

interface MetricLine {
  name: string;
  help: string;
  type: "counter" | "gauge";
  value: number;
}

async function collectMetrics(): Promise<MetricLine[]> {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const [spaces, users] = await Promise.all([activeSpaceCount(), userCount()]);
  const jobQueue = getJobQueueStats();

  return [
    {
      name: "vektor_process_uptime_seconds",
      help: "Process uptime in seconds.",
      type: "gauge",
      value: process.uptime(),
    },
    {
      name: "vektor_http_requests_total",
      help: "Total number of HTTP requests handled since start.",
      type: "counter",
      value: httpRequestsTotal,
    },
    {
      name: "vektor_http_requests_per_second",
      help: `Average HTTP requests per second over the last ${REQUEST_RATE_WINDOW_SECONDS}s.`,
      type: "gauge",
      value: httpRequestsPerSecond(),
    },
    {
      name: "vektor_websocket_active_connections",
      help: "Currently open realtime WebSocket connections.",
      type: "gauge",
      value: activeWebSocketConnections,
    },
    {
      name: "vektor_spaces_total",
      help: "Number of active spaces.",
      type: "gauge",
      value: spaces,
    },
    {
      name: "vektor_users_total",
      help: "Number of registered users.",
      type: "gauge",
      value: users,
    },
    {
      name: "vektor_process_cpu_user_seconds_total",
      help: "Total user CPU time consumed by the process, in seconds.",
      type: "counter",
      value: cpu.user / 1e6,
    },
    {
      name: "vektor_process_cpu_system_seconds_total",
      help: "Total system CPU time consumed by the process, in seconds.",
      type: "counter",
      value: cpu.system / 1e6,
    },
    {
      name: "vektor_process_cpu_seconds_total",
      help: "Total CPU time (user + system) consumed by the process, in seconds.",
      type: "counter",
      value: (cpu.user + cpu.system) / 1e6,
    },
    {
      name: "vektor_process_cpu_utilization_ratio",
      help: `Rolling ${MONITOR_WINDOW_SECONDS}s CPU usage as a fraction of one core (1.0 = one core fully busy).`,
      type: "gauge",
      value: rollingCpuUtilizationRatio(),
    },
    {
      name: "vektor_event_loop_delay_seconds",
      help: "Most recent event loop delay sample, in seconds (time a scheduled timer fired late).",
      type: "gauge",
      value: eventLoopDelayLastMs / 1000,
    },
    {
      name: "vektor_event_loop_delay_max_seconds",
      help: `Peak event loop delay over the last ${MONITOR_WINDOW_SECONDS}s, in seconds. Sustained multi-second values mean the single-threaded loop was blocked, stalling all clients.`,
      type: "gauge",
      value: rollingEventLoopDelayMaxSeconds(),
    },
    {
      name: "vektor_memory_rss_bytes",
      help: "Resident set size (total memory allocated for the process).",
      type: "gauge",
      value: memory.rss,
    },
    {
      name: "vektor_memory_heap_total_bytes",
      help: "Total size of the V8 heap.",
      type: "gauge",
      value: memory.heapTotal,
    },
    {
      name: "vektor_memory_heap_used_bytes",
      help: "Used size of the V8 heap.",
      type: "gauge",
      value: memory.heapUsed,
    },
    {
      name: "vektor_memory_external_bytes",
      help: "Memory used by C++ objects bound to JavaScript objects.",
      type: "gauge",
      value: memory.external,
    },
    {
      name: "vektor_memory_array_buffers_bytes",
      help: "Memory allocated for ArrayBuffers and SharedArrayBuffers.",
      type: "gauge",
      value: memory.arrayBuffers,
    },
    {
      name: "vektor_job_queue_active",
      help: "Job executions currently holding a worker slot.",
      type: "gauge",
      value: jobQueue.active,
    },
    {
      name: "vektor_job_queue_waiting",
      help: "Job executions waiting for a free worker slot.",
      type: "gauge",
      value: jobQueue.waiting,
    },
    {
      name: "vektor_jobs_queued_total",
      help: "Total number of job executions queued since start.",
      type: "counter",
      value: jobQueue.queuedTotal,
    },
    {
      name: "vektor_jobs_succeeded_total",
      help: "Total number of job executions that completed successfully since start.",
      type: "counter",
      value: jobQueue.succeededTotal,
    },
    {
      name: "vektor_jobs_failed_total",
      help: "Total number of job executions that failed, were cancelled, or timed out since start.",
      type: "counter",
      value: jobQueue.failedTotal,
    },
    {
      name: "vektor_workflow_runs_active",
      help: "Workflow runs currently executing in-process.",
      type: "gauge",
      value: activeRuns.size,
    },
  ];
}

/** Content type for the Prometheus text exposition format. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Renders the current metrics snapshot in Prometheus exposition format. */
export async function renderPrometheusMetrics(): Promise<string> {
  const lines: string[] = [];
  for (const metric of await collectMetrics()) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    lines.push(`${metric.name} ${metric.value}`);
  }
  return `${lines.join("\n")}\n`;
}
