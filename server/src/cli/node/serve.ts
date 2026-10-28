import { randomUUID } from "node:crypto";
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
 * `vektor agent serve` — makes this device a node: it dials the server, then
 * runs the agents the server sends tasks to, as subprocesses speaking ACP, and
 * relays their updates back. The node is a bridge, not an agent. It also runs
 * the server's jobs and workflow scripts in its own job VM.
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
function mcpLaunch(
  host: string,
  access: { spaceId: string; jobToken: string },
  taskId: string,
): McpLaunch {
  const env = {
    VEKTOR_HOST: host,
    VEKTOR_SPACE_ID: access.spaceId,
    VEKTOR_JOB_TOKEN: access.jobToken,
    VEKTOR_TASK_ID: taskId,
  };
  // Compiled, the binary is the CLI; from source, the script is.
  const compiled = import.meta.url.includes("$bunfs");
  return {
    command: process.execPath,
    args: compiled ? ["mcp"] : [process.argv[1], "mcp"],
    env,
  };
}

type Running = {
  opening: Promise<AdapterSession>;
  cancelled: boolean;
};

type RunningJob = {
  controller: AbortController;
  touch(): void;
  /** Capability calls waiting for the server's reply. */
  calls: Map<string, PromiseWithResolvers<unknown>>;
};

const log = (message: string) => process.stderr.write(`${message}\n`);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

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

  const running = new Map<string, Running>();
  /** Frames that could not be sent because the server was away. */
  const outbox: NodeToServerFrame[] = [];
  const screens = new Map<string, ScreenSession>();
  const jobs = new Map<string, RunningJob>();
  const jobVm = createBoaJobVm({ execAllowlist: JOB_EXEC_ALLOWLIST });
  let socket: WebSocket | null = null;

  function send(frame: NodeToServerFrame) {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(frame));
      return;
    }
    // A ping is only worth sending to a server that is there, and a job's
    // frames only to the connection it ran on: the server fails it on disconnect.
    if (frame.type === "ping" || frame.type.startsWith("job.")) return;
    outbox.push(frame);
    if (outbox.length > MAX_OUTBOX) outbox.shift();
  }

  function finish(
    taskId: string,
    stopReason: "end_turn" | "cancelled" | "error",
    error?: string,
  ) {
    send({ type: "session.result", taskId, stopReason, ...(error ? { error } : {}) });
  }

  /** Sessions stay open between prompts until the server closes them. */
  function closeSession(taskId: string) {
    const entry = running.get(taskId);
    if (!entry) return;
    running.delete(taskId);
    void entry.opening.then((session) => session.close()).catch(() => {});
  }

  function startSession(frame: Extract<ServerToNodeFrame, { type: "session.new" }>) {
    const { taskId } = frame;
    const adapter = adapters.get(frame.adapter);
    if (!adapter) {
      finish(taskId, "error", `This node has no "${frame.adapter}" adapter.`);
      return;
    }
    if (running.size >= options.maxSessions) {
      finish(
        taskId,
        "error",
        `This node is running its maximum of ${options.maxSessions} sessions.`,
      );
      return;
    }
    const opening = adapter.open({
      taskId,
      cwd: workdir,
      mcp: mcpLaunch(connection.host, frame.access, taskId),
      policy,
      spaceId: frame.access.spaceId,
      jobToken: frame.access.jobToken,
    });
    const entry: Running = { opening, cancelled: false };
    running.set(taskId, entry);
    // A failed start is reported when the prompt that follows arrives.
    void opening.then(
      (session) => session.screen && send({ type: "session.screen", taskId }),
      () => {},
    );
  }

  /** Relays one viewer's screen until either side ends it. */
  async function openScreen(taskId: string, screenId: string) {
    const session = await running.get(taskId)?.opening.catch(() => undefined);
    if (!session?.screen) {
      send({ type: "screen.end", screenId, error: "This task has no screen." });
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
      send({
        type: "screen.end",
        screenId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      screens.delete(screenId);
      screen.close();
    }
  }

  async function prompt(taskId: string, text: string) {
    const entry = running.get(taskId);
    if (!entry) {
      finish(taskId, "error", "This node has no such session; it may have restarted.");
      return;
    }
    let session: AdapterSession;
    try {
      session = await entry.opening;
    } catch (error) {
      finish(taskId, "error", error instanceof Error ? error.message : String(error));
      return;
    }
    if (entry.cancelled) {
      entry.cancelled = false;
      finish(taskId, "cancelled");
      return;
    }
    const result = await session.prompt(text, (update) =>
      send({ type: "session.update", taskId, update }),
    );
    entry.cancelled = false;
    finish(taskId, result.stopReason, result.error);
  }

  /**
   * Runs a job in this node's VM. The portable capabilities, the scratch
   * directory and `exec` run here; every other capability is asked of the
   * server, which grants or refuses it.
   */
  function runJob(frame: Extract<ServerToNodeFrame, { type: "job.run" }>) {
    const { jobId } = frame;
    const controller = new AbortController();
    const calls = new Map<string, PromiseWithResolvers<unknown>>();
    const host = jobVm.hostCapabilities(controller.signal);
    const local: CapabilityTable = {
      ...createPortableCapabilities((url, init) => fetch(url, init), controller.signal),
      ...host.table,
    };
    const relay =
      (name: string) =>
      (...args: unknown[]) => {
        const callId = randomUUID();
        const call = Promise.withResolvers<unknown>();
        calls.set(callId, call);
        send({ type: "job.call", jobId, callId, name, args });
        return call.promise;
      };
    const capabilities = new Proxy(local, {
      get: (table, name) =>
        typeof name !== "string"
          ? undefined
          : Object.hasOwn(table, name)
            ? table[name]
            : relay(name),
    });
    const running = jobVm.run({
      script: frame.script,
      inputs: frame.inputs,
      capabilities,
      onLog: (message) => send({ type: "job.log", jobId, message }),
      timeoutMs: frame.timeoutMs,
      signal: controller.signal,
    });
    jobs.set(jobId, { controller, touch: running.touch, calls });
    void running.result
      .then(
        (output) => send({ type: "job.result", jobId, output: output ?? null }),
        (error) =>
          send({
            type: "job.result",
            jobId,
            error: error instanceof Error ? error.message : String(error),
          }),
      )
      .finally(() => {
        jobs.delete(jobId);
        void host.dispose();
      });
  }

  function answerJobCall(frame: Extract<ServerToNodeFrame, { type: "job.reply" }>) {
    const calls = jobs.get(frame.jobId)?.calls;
    const call = calls?.get(frame.callId);
    if (!call) return;
    calls?.delete(frame.callId);
    if (frame.error === undefined) call.resolve(frame.value ?? null);
    else call.reject(new Error(frame.error));
  }

  function handle(frame: ServerToNodeFrame) {
    if (frame.type === "ping") return;
    if (frame.type === "session.new") startSession(frame);
    else if (frame.type === "session.prompt") void prompt(frame.taskId, frame.text);
    else if (frame.type === "session.close") closeSession(frame.taskId);
    else if (frame.type === "screen.open") void openScreen(frame.taskId, frame.screenId);
    else if (frame.type === "screen.input")
      screens.get(frame.screenId)?.input(frame.events);
    else if (frame.type === "screen.close") screens.get(frame.screenId)?.close();
    else if (frame.type === "job.run") runJob(frame);
    else if (frame.type === "job.reply") answerJobCall(frame);
    else if (frame.type === "job.touch") jobs.get(frame.jobId)?.touch();
    else if (frame.type === "job.cancel") jobs.get(frame.jobId)?.controller.abort();
    else if (frame.type === "session.cancel") {
      const entry = running.get(frame.taskId);
      if (!entry) return;
      entry.cancelled = true;
      void entry.opening.then((session) => session.cancel()).catch(() => {});
    }
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
        // Results still waiting in the outbox count as running, or the server
        // would fail those tasks before it hears how they ended.
        const sessions = [
          ...running.keys(),
          ...outbox.flatMap((f) => (f.type === "session.result" ? [f.taskId] : [])),
        ];
        ws.send(
          JSON.stringify({
            type: "hello",
            name,
            os: platform(),
            workdir,
            adapters: [...adapters.keys()],
            maxSessions: options.maxSessions,
            sessions,
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
        // The server has failed them; their capability calls would go unanswered.
        for (const job of jobs.values()) job.controller.abort();
        done(event.code);
      };
    });
  }

  const stop = async () => {
    await Promise.all(
      [...running.values()].map((entry) =>
        entry.opening.then((session) => session.close()).catch(() => {}),
      ),
    );
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  log(
    `vektor node "${name}" · ${connection.host} · space ${connection.spaceId} · adapters ${[...adapters.keys()].join(", ")}${options.shared ? " · runs jobs for the whole space" : ""}`,
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
