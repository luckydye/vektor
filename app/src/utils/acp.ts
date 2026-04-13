import { once } from "node:events";
import { spawn } from "node:child_process";
import { access, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

type JsonRpcId = number;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type AcpPermissionOption = {
  optionId: string;
  kind: string;
};

type AcpPermissionRequest = {
  options: AcpPermissionOption[];
};

type AcpSessionUpdate = {
  sessionUpdate?: string;
  content?: {
    type?: string;
    text?: string;
  };
};

type AcpSessionUpdateNotification = {
  update?: AcpSessionUpdate;
};

export type AcpPromptResult = {
  content: string;
  stopReason: string;
};

type AcpMcpServerConfig = {
  type: "remote";
  url: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  timeout?: number;
};

export function parseAcpCommand(command: string): { bin: string; args: string[] } {
  const parts = command
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error("WIKI_ACP_COMMAND must not be empty");
  }
  return {
    bin: parts[0]!,
    args: parts.slice(1),
  };
}

function getPreferredPermissionOptionId(options: AcpPermissionOption[]): string {
  const allowOnce = options.find((option) => option.kind === "allow_once");
  if (allowOnce) return allowOnce.optionId;

  const allowAlways = options.find((option) => option.kind === "allow_always");
  if (allowAlways) return allowAlways.optionId;

  throw new Error("ACP agent requested permission without an allow option");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function prepareAcpRuntimeHome(cwd: string): Promise<string> {
  if (!cwd) {
    throw new Error("ACP cwd must not be empty");
  }
  const cwdHash = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  const dataHome = join(tmpdir(), "vektor", "opencode-runtime", cwdHash);
  const opencodeHome = join(dataHome, "opencode");
  await mkdir(opencodeHome, { recursive: true });

  const globalAuthPath = join(homedir(), ".local", "share", "opencode", "auth.json");
  const runtimeAuthPath = join(opencodeHome, "auth.json");
  if ((await pathExists(globalAuthPath)) && !(await pathExists(runtimeAuthPath))) {
    await copyFile(globalAuthPath, runtimeAuthPath);
  }

  return dataHome;
}

function normalizeAcpStartupError(message: string): Error {
  if (message.includes("attempt to write a readonly database")) {
    return new Error(
      "OpenCode ACP could not write its runtime database. Set a writable runtime home or check sandbox permissions.",
    );
  }
  if (message.includes("Failed to start server on port")) {
    return new Error(
      "OpenCode ACP could not start its local server. This environment likely blocks local listen() calls.",
    );
  }
  return new Error(message);
}

export async function runAcpPrompt(options: {
  command: string;
  cwd: string;
  prompt: string;
  apiUrl?: string;
  spaceId?: string;
  documentId?: string;
  jobToken?: string;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void | Promise<void>;
}): Promise<AcpPromptResult> {
  const { command, cwd, prompt, apiUrl, spaceId, documentId, jobToken, signal, onChunk } =
    options;
  const { bin, args } = parseAcpCommand(command);
  const dataHome = await prepareAcpRuntimeHome(cwd);
  const mcpServers: Record<string, AcpMcpServerConfig> = {};
  if (apiUrl && spaceId && jobToken) {
    mcpServers.vektor = {
      type: "remote",
      url: new URL(`/api/v1/spaces/${spaceId}/mcp`, apiUrl).toString(),
      headers: {
        "X-Job-Token": jobToken,
        "X-Space-Id": spaceId,
        ...(documentId ? { "X-Vektor-Document-Id": documentId } : {}),
      },
      enabled: true,
      timeout: 20_000,
    };
  }
  const child = spawn(bin, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: dataHome,
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: "1",
      OPENCODE_CLIENT: "vektor-api",
      ...(apiUrl ? { VEKTOR_API_URL: apiUrl } : {}),
      ...(spaceId ? { VEKTOR_SPACE_ID: spaceId } : {}),
      ...(documentId ? { VEKTOR_DOCUMENT_ID: documentId } : {}),
      ...(jobToken ? { VEKTOR_JOB_TOKEN: jobToken } : {}),
    },
  });

  const pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  const stderr: string[] = [];
  const agentChunks: string[] = [];
  let nextId = 0;
  let stdoutBuffer = "";
  let closed = false;
  let outputQueue = Promise.resolve();

  const failPending = (error: Error) => {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  };

  const closeChild = () => {
    if (closed) return;
    closed = true;
    child.stdin.end();
    child.kill();
  };

  const sendMessage = async (message: JsonRpcRequest | JsonRpcResponse) => {
    if (closed || child.stdin.destroyed) {
      throw new Error("ACP process is not writable");
    }
    const writable = child.stdin.write(`${JSON.stringify(message)}\n`);
    if (!writable) {
      await once(child.stdin, "drain");
    }
  };

  const sendRequest = async (method: string, params?: unknown) => {
    const id = nextId++;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    await sendMessage({
      jsonrpc: "2.0",
      id,
      method,
      params,
    });
    return await responsePromise;
  };

  const handleMessage = async (message: unknown) => {
    if (!message || typeof message !== "object") {
      throw new Error("ACP process emitted a non-object message");
    }

    if (
      "method" in message &&
      typeof (message as { method?: unknown }).method === "string"
    ) {
      const notification = message as JsonRpcNotification & { id?: unknown };
      if (notification.method === "session/update") {
        const params = (notification.params ?? {}) as AcpSessionUpdateNotification;
        const update = params.update;
        if (
          update?.sessionUpdate === "agent_message_chunk" &&
          update.content?.type === "text" &&
          typeof update.content.text === "string"
        ) {
          agentChunks.push(update.content.text);
          await onChunk?.(update.content.text);
        }
        return;
      }

      if (notification.method === "session/request_permission") {
        const request = (notification.params ?? {}) as AcpPermissionRequest;
        const optionId = getPreferredPermissionOptionId(request.options ?? []);
        if (typeof notification.id !== "number") {
          throw new Error("ACP permission request missing request id");
        }
        await sendMessage({
          jsonrpc: "2.0",
          id: notification.id,
          result: {
            outcome: {
              outcome: "selected",
              optionId,
            },
          },
        });
        return;
      }

      throw new Error(`Unsupported ACP notification: ${notification.method}`);
    }

    if ("id" in message && typeof (message as { id?: unknown }).id === "number") {
      const response = message as JsonRpcResponse;
      const pendingRequest = pending.get(response.id);
      if (!pendingRequest) {
        throw new Error(`Received unexpected ACP response id ${response.id}`);
      }
      pending.delete(response.id);
      if (response.error) {
        pendingRequest.reject(
          new Error(response.error.message || `ACP request ${response.id} failed`),
        );
        return;
      }
      pendingRequest.resolve(response.result);
      return;
    }

    throw new Error("ACP process emitted an invalid notification");
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    outputQueue = outputQueue
      .then(async () => {
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            failPending(new Error("ACP process emitted invalid JSON"));
            closeChild();
            return;
          }
          try {
            await handleMessage(parsed);
          } catch (error) {
            failPending(error instanceof Error ? error : new Error(String(error)));
            closeChild();
            return;
          }
        }
      })
      .catch((error) => {
        failPending(error instanceof Error ? error : new Error(String(error)));
        closeChild();
      });
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr.push(chunk);
  });

  child.on("error", (error) => {
    failPending(error instanceof Error ? error : new Error(String(error)));
    closeChild();
  });

  child.on("close", (code) => {
    if (closed) return;
    closed = true;
    const stderrText = stderr.join("").trim();
    const suffix = stderrText ? `: ${stderrText}` : "";
    failPending(
      normalizeAcpStartupError(
        `ACP process exited with code ${code ?? "unknown"}${suffix}`,
      ),
    );
  });

  const abort = () => {
    failPending(new Error("ACP request cancelled"));
    closeChild();
  };
  signal?.addEventListener("abort", abort, { once: true });

  try {
    await sendRequest("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: "vektor-api",
        title: "Vektor API",
        version: "1.0.0",
      },
    });

    const sessionResult = (await sendRequest("session/new", {
      cwd,
      mcpServers,
    })) as { sessionId?: string } | null;
    const sessionId = sessionResult?.sessionId;
    if (!sessionId) {
      throw new Error("ACP agent did not return a sessionId");
    }

    const promptResult = (await sendRequest("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }],
    })) as { stopReason?: string } | null;
    await outputQueue;

    const stopReason = promptResult?.stopReason;
    if (!stopReason) {
      throw new Error("ACP agent did not return a stopReason");
    }

    const content = agentChunks.join("");
    if (!content.trim()) {
      throw new Error("ACP agent returned no output");
    }

    return { content, stopReason };
  } finally {
    signal?.removeEventListener("abort", abort);
    closeChild();
  }
}
