/**
 * Lightweight in-process metrics for operational visibility. Deliberately
 * dependency-free: counters and gauges are updated from hot paths (HTTP
 * middleware, WebSocket lifecycle) and rendered on demand at `/metrics`.
 *
 * The output uses the Prometheus text exposition format so it can be scraped
 * directly by Prometheus/Grafana or read by hand during debugging.
 */

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

interface MetricLine {
  name: string;
  help: string;
  type: "counter" | "gauge";
  value: number;
}

function collectMetrics(): MetricLine[] {
  const memory = process.memoryUsage();

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
  ];
}

/** Content type for the Prometheus text exposition format. */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/** Renders the current metrics snapshot in Prometheus exposition format. */
export function renderPrometheusMetrics(): string {
  const lines: string[] = [];
  for (const metric of collectMetrics()) {
    lines.push(`# HELP ${metric.name} ${metric.help}`);
    lines.push(`# TYPE ${metric.name} ${metric.type}`);
    lines.push(`${metric.name} ${metric.value}`);
  }
  return `${lines.join("\n")}\n`;
}
