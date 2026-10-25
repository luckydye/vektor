import { answerPermission } from "./policy.ts";
import type { AdapterSession, PromptResult, SessionInit } from "./types.ts";

/**
 * A client of an ACP agent over a line-delimited JSON-RPC pipe: an agent
 * subprocess's stdio, or the same through a VM's exec.
 */

export type StdioTransport = {
  write(line: string): void;
  lines: AsyncIterable<string>;
  stop(): void;
  exited: Promise<unknown>;
};

export function spawnTransport(
  argv: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): StdioTransport {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  async function* lines() {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        yield buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield buffer;
  }
  return {
    write(line) {
      proc.stdin.write(`${line}\n`);
      proc.stdin.flush();
    },
    lines: lines(),
    stop: () => proc.kill(),
    exited: proc.exited,
  };
}

type Handlers = {
  onNotification(method: string, params: unknown): void;
  onRequest(method: string, params: unknown): Promise<unknown>;
};

class AcpConnection {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(
    private transport: StdioTransport,
    private handlers: Handlers,
  ) {
    void this.read();
  }

  private async read() {
    try {
      for await (const line of this.transport.lines) {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        this.dispatch(message);
      }
    } finally {
      for (const call of this.pending.values()) {
        call.reject(new Error("The agent process exited."));
      }
      this.pending.clear();
    }
  }

  private dispatch(message: Record<string, unknown>) {
    const { id, method } = message;
    if (typeof method === "string") {
      if (id === undefined) {
        this.handlers.onNotification(method, message.params);
        return;
      }
      this.handlers.onRequest(method, message.params).then(
        (result) => this.write({ jsonrpc: "2.0", id, result }),
        (error: unknown) =>
          this.write({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }),
      );
      return;
    }
    const call = typeof id === "number" ? this.pending.get(id) : undefined;
    if (!call) return;
    this.pending.delete(id as number);
    const error = message.error as { message?: string } | undefined;
    if (error) call.reject(new Error(error.message ?? "The agent returned an error."));
    else call.resolve(message.result);
  }

  private write(message: object) {
    this.transport.write(JSON.stringify(message));
  }

  request<T>(method: string, params: object): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: object) {
    this.write({ jsonrpc: "2.0", method, params });
  }
}

const STOP_REASONS: Record<string, PromptResult> = {
  end_turn: { stopReason: "end_turn" },
  max_tokens: { stopReason: "end_turn" },
  max_turn_requests: { stopReason: "end_turn" },
  cancelled: { stopReason: "cancelled" },
  refusal: { stopReason: "error", error: "The agent refused the task." },
};

/** Opens a session on an ACP agent that is already running behind `transport`. */
export async function openAcpSession(
  transport: StdioTransport,
  init: SessionInit,
  options: { cwd?: string } = {},
): Promise<AdapterSession> {
  let onUpdate: ((update: Record<string, unknown>) => void) | undefined;
  const connection = new AcpConnection(transport, {
    onNotification(method, params) {
      if (method !== "session/update") return;
      const update = (params as { update?: Record<string, unknown> } | undefined)?.update;
      if (update) onUpdate?.(update);
    },
    async onRequest(method, params) {
      if (method === "session/request_permission") {
        return answerPermission(init.policy, params);
      }
      throw new Error(`Unsupported request: ${method}`);
    },
  });

  try {
    await connection.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
    });
    const { sessionId } = await connection.request<{ sessionId: string }>("session/new", {
      cwd: options.cwd ?? init.cwd,
      mcpServers: init.mcp
        ? [
            {
              name: "vektor",
              command: init.mcp.command,
              args: init.mcp.args,
              env: Object.entries(init.mcp.env).map(([name, value]) => ({ name, value })),
            },
          ]
        : [],
    });

    return {
      async prompt(text, handler) {
        onUpdate = handler;
        try {
          const result = await connection.request<{ stopReason?: string }>(
            "session/prompt",
            {
              sessionId,
              prompt: [{ type: "text", text }],
            },
          );
          return (
            STOP_REASONS[result.stopReason ?? "end_turn"] ?? { stopReason: "end_turn" }
          );
        } catch (error) {
          return {
            stopReason: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          onUpdate = undefined;
        }
      },
      cancel: () => connection.notify("session/cancel", { sessionId }),
      async close() {
        transport.stop();
        await transport.exited;
      },
    };
  } catch (error) {
    transport.stop();
    throw error;
  }
}
