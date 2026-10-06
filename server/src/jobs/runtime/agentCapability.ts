/**
 * The `agentPrompt` capability: one turn in a server-side agent session, streamed.
 *
 * This protocol handling used to live inside the `agent` extension job, which
 * parsed SSE frames and JSON-RPC envelopes in guest code. It belongs on the host
 * instead: the guest has no streaming primitive (a capability call resolves once,
 * with a complete value), and doing it here means the agent's plan and tool-call
 * lines reach the run log *while* the turn is happening rather than after it.
 */

interface AcpUpdate {
  sessionUpdate?: string;
  content?: unknown;
  entries?: Array<{ content?: string }>;
  title?: string;
  toolName?: string;
  input?: unknown;
  status?: string;
}

interface AcpFrame {
  id?: string | number | null;
  error?: { code?: string | number; message?: string };
  result?: { stopReason?: string };
  method?: string;
  params?: { update?: AcpUpdate };
}

export interface AgentPromptOptions {
  origin: string;
  spaceId: string;
  token: string;
  /** The session to continue; unset opens a new one in the run user's chat history. */
  sessionId?: string;
  onLog: (message: string) => void;
  signal?: AbortSignal;
}

async function acpRequest(
  method: string,
  params: Record<string, unknown>,
  options: AgentPromptOptions,
): Promise<{ requestId: string; response: Response }> {
  const requestId = crypto.randomUUID();
  const response = await fetch(`${options.origin}/api/v1/chat/acp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Job-Token": options.token,
      "X-Space-Id": options.spaceId,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params: { spaceId: options.spaceId, ...params },
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(
      `ACP ${method} failed (${response.status}): ${await response.text()}`,
    );
  }
  return { requestId, response };
}

/** Send one prompt to the agent and resolve with its session and final text. */
export async function agentPrompt(
  text: string,
  options: AgentPromptOptions,
): Promise<{ sessionId: string; text: string }> {
  const { onLog } = options;
  if (!text.trim()) throw new Error("agentPrompt: text is required");
  const sessionId = options.sessionId ?? (await newSession(text, options));

  onLog(`Calling ACP agent (sessionId: ${sessionId})`);

  const { requestId, response } = await acpRequest(
    "session/prompt",
    { sessionId, prompt: [{ type: "text", text }] },
    options,
  );
  if (!response.body) throw new Error("ACP session/prompt returned no body");

  const collected: string[] = [];
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  let stopReason: string | null = null;
  let acpError: string | null = null;

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") {
          finished = true;
          break;
        }

        let parsed: AcpFrame;
        try {
          parsed = JSON.parse(payload) as AcpFrame;
        } catch {
          continue; // skip malformed JSON
        }

        if (parsed.error) {
          acpError = parsed.error.message ?? "ACP error";
          continue;
        }

        // Final session/prompt result: { id, result: { stopReason } }.
        if (parsed.id === requestId && parsed.result) {
          if (typeof parsed.result.stopReason === "string") {
            stopReason = parsed.result.stopReason;
          }
          continue;
        }

        if (parsed.method !== "session/update") continue;
        const update = parsed.params?.update;
        if (!update) continue;

        switch (update.sessionUpdate) {
          case "agent_message_chunk": {
            const content = update.content as
              | { type?: string; text?: string }
              | undefined;
            if (content?.type === "text" && typeof content.text === "string") {
              collected.push(content.text);
            }
            break;
          }
          case "plan": {
            const first = update.entries?.[0];
            if (typeof first?.content === "string") onLog(first.content);
            break;
          }
          case "tool_call": {
            const toolName = update.title ?? "tool";
            const args =
              update.input !== undefined && update.input !== null
                ? `: ${JSON.stringify(update.input).slice(0, 300)}`
                : "";
            onLog(`→ ${toolName}${args}`);
            // Only text emitted after the final tool result is the answer;
            // discard whatever accumulated before each tool call.
            collected.length = 0;
            break;
          }
          case "tool_call_update": {
            const status = update.status;
            if (status !== "completed" && status !== "failed") break;
            const toolName = update.toolName ?? "tool";
            const entries = update.content as
              | Array<{ content?: { text?: string } }>
              | undefined;
            const preview = entries?.[0]?.content?.text?.slice(0, 300) ?? "(empty)";
            onLog(`${status === "failed" ? "✗" : "←"} ${toolName}: ${preview}`);
            break;
          }
        }
      }
      if (finished) break;
    }
    if (finished) break;
  }

  const answer = collected.join("");
  if (!answer.trim()) {
    if (acpError) throw new Error(`ACP agent error: ${acpError}`);
    throw new Error(
      `Agent returned no text output (stopReason: ${stopReason ?? "unknown"})`,
    );
  }

  onLog(`Output: ${answer.length} chars`);
  return { sessionId, text: answer };
}

async function newSession(text: string, options: AgentPromptOptions): Promise<string> {
  const { response } = await acpRequest(
    "session/new",
    { title: text.trim().slice(0, 60) },
    options,
  );
  const body = (await response.json()) as { result?: { sessionId?: unknown } };
  const sessionId = body.result?.sessionId;
  if (typeof sessionId !== "string") {
    throw new Error("ACP session/new returned no sessionId");
  }
  return sessionId;
}
