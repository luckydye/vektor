# Benchmarks

Run everything from the `app/` directory (so `#`-imports and `./data` resolve).

## `perf.ts`
HTTP latency benchmark against the release binary with a seeded ~10k-doc DB,
compared to `data/baseline.json`. See the header of `perf.ts` for flags.

```
bun bench/perf.ts
```

## Collaboration / canvas benchmarks

Added while investigating a realtime-collaboration hang on large canvases. The
load harnesses talk to a running server over the WebSocket protocol
(`ws://<host>/events/<spaceId>`); `canvas-ops` is standalone (read-only on the
DB). All are env-configurable — defaults point at the local `greaet-canvas`
doc; override `HOST`, `SPACE`, `DOC` (or `BENCH_DB`/`BENCH_DOC`).

### `canvas-ops.mjs` — server-side Yjs op micro-benchmark (standalone)
Loads a real canvas document and times `parseCanvasContent`, `seedCanvasDoc`,
`encodeStateAsUpdate`, and snapshot+stringify, with `bun:jsc` heap stats. Best
run under Bun's profilers:
```
bun --cpu-prof-md --heap-prof bench/canvas-ops.mjs
BENCH_DB=data/spaces/<spaceId>.db BENCH_DOC=<docId> bun bench/canvas-ops.mjs
```

### `stress.mjs` — hang reproduction (needs a running server)
Reconnect storm + draw/erase churn. Reproduces the multi-second event-loop
block on a large canvas.
```
RECONNECTORS=14 DRAWERS=2 SECONDS=80 bun bench/stress.mjs
```

### `presence-load.mjs` — presence throughput/latency (needs a running server)
N clients streaming presence updates; reports send/recv rates, broadcast
latency, amplification, and stalls.
```
CLIENTS=3 RATE=60 SECONDS=30 YJS=1 bun bench/presence-load.mjs
```

### `yjs-join-probe.mjs` — join-state timing (needs a running server)
Measures time from `YjsJoin` to receiving the full document state.
```
SECONDS=20 bun bench/yjs-join-probe.mjs
```

## Profiling a running server
The compiled binary doesn't accept Bun runtime flags, so profile from source:
```
DEV=true VEKTOR_NO_AUTH=1 bun --cpu-prof-md --heap-prof src/server.ts
```
`--cpu-prof-md` writes an LLM/grep-friendly CPU profile on exit; the event-loop
lag + GC tracing in `src/observability/trace.ts` logs blocks to stdout.
