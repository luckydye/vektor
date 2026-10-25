import { acpCall, streamAcpPrompt } from "#cli/agent.ts";
import { openAcpSession, spawnTransport } from "./acpClient.ts";
import type { Adapter, AdapterSession } from "./types.ts";

/** Answers with what it was asked; for trying a node out. */
export const echoAdapter: Adapter = {
  async open() {
    return {
      async prompt(text, onUpdate) {
        onUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `echo: ${text}` },
        });
        return { stopReason: "end_turn" };
      },
      cancel() {},
      async close() {},
    };
  },
};

/** Any agent that speaks ACP on stdio, started as `command` in the session's directory. */
export function commandAdapter(command: string[]): Adapter {
  return {
    open: (init) => openAcpSession(spawnTransport(command, { cwd: init.cwd }), init),
  };
}

/**
 * The Vektor server's own agent, reached over its ACP endpoint with the
 * node's login. It runs there, not on this device, so it gets no files or
 * tools from the node.
 */
export function vektorAdapter(connection: {
  host: string;
  token: string | undefined;
  spaceId: string;
}): Adapter {
  const authHeaders: Record<string, string> = connection.token
    ? { Authorization: `Bearer ${connection.token}` }
    : {};
  return {
    async open(init): Promise<AdapterSession> {
      const { host, spaceId } = connection;
      const { sessionId } = await acpCall<{ sessionId: string }>(
        host,
        authHeaders,
        "session/new",
        { spaceId, title: `Node task ${init.taskId}`.slice(0, 60) },
      );
      let controller: AbortController | undefined;
      return {
        async prompt(text, onUpdate) {
          controller = new AbortController();
          try {
            await streamAcpPrompt(
              host,
              authHeaders,
              {
                sessionId,
                spaceId,
                prompt: [{ type: "text", text }],
                timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              },
              onUpdate,
              controller.signal,
            );
            return { stopReason: "end_turn" };
          } catch (error) {
            if (controller.signal.aborted) return { stopReason: "cancelled" };
            return {
              stopReason: "error",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
        cancel() {
          controller?.abort();
          void acpCall(host, authHeaders, "session/cancel", { spaceId, sessionId });
        },
        async close() {},
      };
    },
  };
}
