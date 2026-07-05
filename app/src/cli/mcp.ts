import { config } from "../config.ts";
import {
  createParseErrorResponse,
  handleMcpRequest,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type VektorMcpConfig,
} from "../utils/vektorMcp.ts";
import { resolveHost, resolveSpaceId } from "./resolve.ts";

function writeResponse(response: JsonRpcResponse | null): void {
  if (!response) return;
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

async function handleLine(line: string, mcpConfig: VektorMcpConfig): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(trimmed) as JsonRpcRequest;
  } catch {
    writeResponse(createParseErrorResponse());
    return;
  }

  writeResponse(await handleMcpRequest(mcpConfig, request));
}

export async function commandMcp(): Promise<void> {
  const apiUrl = resolveHost().replace(/\/+$/, "");
  const accessToken = config().CLI_ACCESS_TOKEN;
  const spaceId = await resolveSpaceId(apiUrl, accessToken);
  const mcpConfig: VektorMcpConfig = {
    apiUrl,
    spaceId,
    accessToken,
    connectedProviders: [],
  };

  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of process.stdin) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      await handleLine(line, mcpConfig);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  await handleLine(buffer, mcpConfig);
}
