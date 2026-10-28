import { hostname, platform } from "node:os";
import { resolve } from "node:path";
import {
  encodeScreenMedia,
  NODE_OFFLINE_AFTER_MS,
  NODE_PING_INTERVAL_MS,
  type NodeToServerFrame,
  parseFrame,
  type ServerToNodeFrame,
} from "#agent/nodes/protocol.ts";
import { resolveConfig } from "#cli/resolve.ts";
import { createPortableCapabilities } from "#jobs/runtime/portable.ts";
import type { CapabilityTable } from "#jobs/runtime/types.ts";
import { createBoaJobVm, JOB_EXEC_ALLOWLIST } from "#platform/bun/jobVm.ts";
import type {
  AgentRequest,
  JobRequest,
  PromptResult,
  RunnerHost,
} from "#runners/contract.ts";
import { commandAdapter, echoAdapter, vektorAdapter } from "./adapters.ts";
import { type ManagedOptions, managedAdapter } from "./managed.ts";
import { terminalConfirm } from "./policy.ts";
import type {
  Adapter,
  AdapterSession,
  McpLaunch,
  Policy,
  ScreenSession,
} from "./types.ts";

/**
 * `vektor agent serve` — makes this device a node, a runner that dials in
 * (docs/runners.md): it gets runner requests over its socket, runs jobs in
 * its own job VM and agents as subprocesses speaking ACP, and makes each run's
 * calls to the server over HTTP. For agents the node is a bridge, not an agent.
 */

const WS_CLOSE_UNAUTHORIZED = 4401;
const WS_CLOSE_FORBIDDEN = 4403;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Frames kept for a server that is away; the oldest go first. */
const MAX_OUTBOX = 10_000;
/** Media a slow server may have queued before a screen is ended rather than lag further. */
const MAX_SCREEN_BUFFER_BYTES = 8 * 1024 * 1024;

export type ServeOptions = {
  name?: string;
  workdir: string;
  maxSessions: number;
  /** Which adapters to offer, in order of preference; default is all that are available. */
  adapters?: string[];
  /** Extra adapters: a name and the command that starts an ACP agent on stdio. */
  commands: Record<string, string[]>;
  readonly: boolean;
  autoApprove: boolean;
  allowShell: boolean;
  /** Adapters that run agents in environments made by a CLI speaking the environment manager protocol: a name and its command. */
  managers: Record<string, string[]>;
  /** How those environments are used; each manager's own command and the server's host are added. */
  managed: Omit<ManagedOptions, "manager" | "host">;
  /** Runs jobs for anyone in the space, not only for the logged-in user. */
  shared: boolean;
};

/** Bun's WebSocket constructor also takes request headers, which the DOM typings lack. */
type WebSocketInit = ConstructorParameters<typeof WebSocket>[1] & {
  headers?: Record<string, string>;
};

type Connection = { host: string; token: string | undefined; spaceId: string };

function buildAdapters(options: ServeOptions, connection: Connection) {
  const available = new Map<string, Adapter>();
  available.set("vektor", vektorAdapter(connection));
  if (Bun.which("opencode"))
    available.set("opencode", commandAdapter(["opencode", "acp"]));
  for (const [name, command] of Object.entries(options.commands)) {
    available.set(name, commandAdapter(command));
  }
  for (const [name, manager] of Object.entries(options.managers)) {
    available.set(
      name,
      managedAdapter({ ...options.managed, manager, host: connection.host }),
    );
  }
  available.set("echo", echoAdapter);

  const names = options.adapters ?? [...available.keys()];
  const missing = names.filter((name) => !available.has(name));
  if (missing.length) {
    throw new Error(
      `No adapter ${missing.join(", ")}. Available: ${[...available.keys()].join(", ")}.`,
    );
  }
  return new Map(names.map((name) => [name, available.get(name) as Adapter]));
}

/** How a session's agent starts the Vektor MCP server, as this very binary. */
function mcpLaunch(host: string, mcp: AgentRequest["mcp"]): McpLaunch {
  const env = {
    VEKTOR_HOST: host,
    VEKTOR_SPACE_ID: mcp.headers["X-Space-Id"] ?? "",
    VEKTOR_JOB_TOKEN: mcp.headers["X-Job-Token"] ?? "",
    VEKTOR_AGENT_SESSION: mcp.headers["X-Agent-Session"] ?? "",
  };
  // Compiled, the binary is the CLI; from source, the script is.
  const compiled = import.meta.url.includes("$bunfs");
  return {
    command: process.execPath,
    args: compiled ? ["mcp"] : [process.argv[1], "mcp"],
    env,
  };
}

/** The server keeps a run's deadline, so the node's VM keeps none of its own. */
const NO_DEADLINE_MS = 2 ** 31 - 1;

const log = (message: string) => process.stderr.write(`${message}\n`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * In order, and as few calls as keep up: what queues while one call is out
 * goes in the next, as one.
 */
function batched<T>(send: (items: T[]) => Promise<unknown>) {
  let queue: T[] = [];
  let flight = Promise.resolve();
  return {
    push(item: T) {
      queue.push(item);
      if (queue.length > 1) return;
      flight = flight
        .then(() => {
          const items = queue;
          queue = [];
          return send(items);
        })
        .then(
          () => {},
          () => {},
        );
    },
    flushed: () => flight,
  };
}

export async function commandAgentServe(options: ServeOptions): Promise<void> {
  const connection = await resolveConfig();
  if (!connection.token && !process.env.VEKTOR_NO_AUTH) {
    log("Not logged in; the server will refuse the node unless it runs with --no-auth.");
  }
  const adapters = buildAdapters(options, connection);
  const name = options.name ?? hostname();
  const workdir = resolve(options.workdir);
  const policy: Policy = {
    workdir,
    readonly: options.readonly,
    autoApprove: options.autoApprove,
    allowShell: options.allowShell,
    confirm: terminalConfirm(),
  };

  /** Agent sessions, kept between turns until the server closes them. */
  const sessions = new Map<string, Promise<AdapterSession>>();
  /** How to stop each run in flight. */
  const runs = new Map<string, () => void>();
  /** Frames that could not be sent because the server was away. */
  const outbox: NodeToServerFrame[] = [];
  const screens = new Map<string, ScreenSession>();
  const jobVm = createBoaJobVm({ execAllowlist: JOB_EXEC_ALLOWLIST });
  let socket: WebSocket | null = null;

  function send(frame: NodeToServerFrame) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
      return;
    }
    // A ping is only worth sending to a server that is there.
    if (frame.type === "ping") return;
    outbox.push(frame);
    if (outbox.length > MAX_OUTBOX) outbox.shift();
  }

  /** A run's calls, to the server this node dialled, whichever origin the server named. */
  function caller(host: RunnerHost, signal?: AbortSignal) {
    const url = new URL(new URL(host.url).pathname, connection.host);
    return async (callName: string, args: unknown[]) => {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${host.token}`,
        },
        body: JSON.stringify({ name: callName, args }),
        signal,
      });
      const { value, error } = (await response.json()) as {
        value?: unknown;
        error?: string;
      };
      if (error !== undefined) throw new Error(error);
      return value;
    };
  }

  /**
   * Runs a job in this node's VM. `fetch`, timers, the compute helpers, the
   * scratch directory and `exec` run here; every other capability, each log
   * line and the result are calls to the server.
   */
  async function runJob({ runId, script, inputs, host }: JobRequest) {
    const controller = new AbortController();
    runs.set(runId, () => controller.abort());
    const call = caller(host, controller.signal);
    const logs = batched<string>(async (lines) => {
      for (const line of lines) await call("log", [line]);
    });
    const scratch = jobVm.hostCapabilities(controller.signal);
    const local: CapabilityTable = {
      ...createPortableCapabilities((url, init) => fetch(url, init), controller.signal),
      ...scratch.table,
    };
    const capabilities = new Proxy(local, {
      get: (table, capability) =>
        typeof capability !== "string"
          ? undefined
          : Object.hasOwn(table, capability)
            ? table[capability]
            : (...args: unknown[]) => call(capability, args),
    });

    let result: { output: unknown } | { error: string };
    try {
      const output = await jobVm.run({
        script,
        inputs,
        capabilities,
        onLog: logs.push,
        timeoutMs: NO_DEADLINE_MS,
        signal: controller.signal,
      }).result;
      result = { output: output ?? null };
    } catch (error) {
      result = { error: message(error) };
    } finally {
      runs.delete(runId);
      await scratch.dispose();
    }
    // Every log line reaches the server before the result does.
    await logs.flushed();
    await call("result", [result]).catch(() => {});
  }

  function openSession({ sessionId, agent, mcp }: AgentRequest) {
    const adapter = adapters.get(agent);
    if (!adapter) throw new Error(`This node has no "${agent}" agent.`);
    if (sessions.size >= options.maxSessions) {
      throw new Error(
        `This node is running its maximum of ${options.maxSessions} sessions.`,
      );
    }
    const opening = adapter.open({
      sessionId,
      cwd: workdir,
      mcp: mcpLaunch(connection.host, mcp),
      policy,
      spaceId: mcp.headers["X-Space-Id"] ?? "",
      jobToken: mcp.headers["X-Job-Token"] ?? "",
    });
    sessions.set(sessionId, opening);
    void opening.then(
      (session) => session.screen && send({ type: "screen", sessionId }),
      () => sessions.delete(sessionId),
    );
    return opening;
  }

  /** One turn of an agent session, opening the session on its first. */
  async function runAgentTurn(request: AgentRequest) {
    const call = caller(request.host);
    const updates = batched<Record<string, unknown>>((items) => call("updates", [items]));
    let result: PromptResult;
    try {
      const session = await (sessions.get(request.sessionId) ?? openSession(request));
      runs.set(request.runId, () => session.cancel());
      result = await session.prompt(request.prompt, updates.push);
    } catch (error) {
      result = { stopReason: "error", error: message(error) };
    } finally {
      runs.delete(request.runId);
    }
    await updates.flushed();
    await call("result", [result]).catch(() => {});
  }

  function closeSession(sessionId: string) {
    const opening = sessions.get(sessionId);
    sessions.delete(sessionId);
    void opening?.then((session) => session.close()).catch(() => {});
  }

  /** Relays one viewer's screen until either side ends it. */
  async function openScreen(sessionId: string, screenId: string) {
    const session = await sessions.get(sessionId)?.catch(() => undefined);
    if (!session?.screen) {
      send({ type: "screen.end", screenId, error: "This session has no screen." });
      return;
    }
    const screen = session.screen();
    screens.set(screenId, screen);
    try {
      for await (const chunk of screen.media) {
        if (socket?.readyState !== WebSocket.OPEN)
          throw new Error("The server went away.");
        if (socket.bufferedAmount > MAX_SCREEN_BUFFER_BYTES) {
          throw new Error("The connection is too slow for the screen.");
        }
        socket.send(encodeScreenMedia(screenId, chunk));
      }
      await screen.ended;
      send({ type: "screen.end", screenId });
    } catch (error) {
      send({ type: "screen.end", screenId, error: message(error) });
    } finally {
      screens.delete(screenId);
      screen.close();
    }
  }

  function handle(frame: ServerToNodeFrame) {
    if (frame.type === "run") {
      const { request } = frame;
      if (request.kind === "job") void runJob(request);
      else if (request.kind === "agent") void runAgentTurn(request);
      else if (request.kind === "agent.close") closeSession(request.sessionId);
    } else if (frame.type === "cancel") runs.get(frame.runId)?.();
    else if (frame.type === "screen.open")
      void openScreen(frame.sessionId, frame.screenId);
    else if (frame.type === "screen.input")
      screens.get(frame.screenId)?.input(frame.events);
    else if (frame.type === "screen.close") screens.get(frame.screenId)?.close();
  }

  /** One connection's life; resolves with the close code once it ends. */
  function connectOnce(onConnected: () => void): Promise<number> {
    const url = `${connection.host.replace(/^http/, "ws")}/nodes/${encodeURIComponent(connection.spaceId)}`;
    return new Promise((done) => {
      const ws = new WebSocket(url, <WebSocketInit>{
        headers: connection.token ? { Authorization: `Bearer ${connection.token}` } : {},
      });
      let lastReceivedAt = Date.now();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastReceivedAt > NODE_OFFLINE_AFTER_MS) {
          ws.close();
          return;
        }
        send({ type: "ping" });
      }, NODE_PING_INTERVAL_MS);

      ws.onopen = () => {
        socket = ws;
        ws.send(
          JSON.stringify({
            type: "hello",
            name,
            os: platform(),
            workdir,
            adapters: [...adapters.keys()],
            maxSessions: options.maxSessions,
            // Runs carry on over HTTP while the socket is down; these are still ours.
            runs: [...runs.keys()],
            shared: options.shared,
          } satisfies NodeToServerFrame),
        );
        for (const frame of outbox.splice(0)) ws.send(JSON.stringify(frame));
        onConnected();
      };
      ws.onmessage = (event) => {
        lastReceivedAt = Date.now();
        const frame = parseFrame<ServerToNodeFrame>(String(event.data));
        if (frame) handle(frame);
      };
      ws.onerror = () => {};
      ws.onclose = (event) => {
        clearInterval(heartbeat);
        if (socket === ws) socket = null;
        done(event.code);
      };
    });
  }

  const stop = async () => {
    await Promise.all(
      [...sessions.values()].map((opening) =>
        opening.then((session) => session.close()).catch(() => {}),
      ),
    );
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  log(
    `vektor node "${name}" · ${connection.host} · space ${connection.spaceId} · agents ${[...adapters.keys()].join(", ")}${options.shared ? " · runs jobs for the whole space" : ""}`,
  );
  let backoff = MIN_BACKOFF_MS;
  while (true) {
    const code = await connectOnce(() => {
      backoff = MIN_BACKOFF_MS;
      log("connected");
    });
    if (code === WS_CLOSE_UNAUTHORIZED || code === WS_CLOSE_FORBIDDEN) {
      throw new Error("The server refused this node. Run `vektor login` and try again.");
    }
    log(`disconnected (${code}); retrying in ${Math.round(backoff / 1000)}s`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}
