import { describe, expect, test } from "vitest";
import { handleMcpRequest } from "#cli/mcp.ts";
import type { VektorMcpConfig } from "#agent/tools.ts";

const config: VektorMcpConfig = {
  apiUrl: "https://vektor.example.test",
  spaceId: "space-test",
};

const requestMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

describe("MCP stdio server", () => {
  test("advertises the modern stateless protocol through server/discover", async () => {
    const response = await handleMcpRequest(config, {
      jsonrpc: "2.0",
      id: "discover-1",
      method: "server/discover",
      params: { _meta: requestMeta },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "discover-1",
      result: {
        resultType: "complete",
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        ttlMs: 3_600_000,
        cacheScope: "public",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "vektor-mcp",
            version: "1.0.0",
          },
        },
      },
    });
  });

  test("requires protocol version and client capabilities on every request", async () => {
    const response = await handleMcpRequest(config, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { _meta: {} },
    });

    expect(response).toMatchObject({
      id: 1,
      error: { code: -32602 },
    });
  });

  test("returns the MCP unsupported-version error with supported versions", async () => {
    const response = await handleMcpRequest(config, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {
        _meta: {
          ...requestMeta,
          "io.modelcontextprotocol/protocolVersion": "2025-11-25",
        },
      },
    });

    expect(response).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: {
        code: -32022,
        message: "Unsupported protocol version",
        data: {
          supported: ["2026-07-28"],
          requested: "2025-11-25",
        },
      },
    });
  });

  test("marks cacheable tool lists and all successful results as complete", async () => {
    const response = await handleMcpRequest(config, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { _meta: requestMeta },
    });

    expect(response?.result).toMatchObject({
      resultType: "complete",
      ttlMs: 300_000,
      cacheScope: "private",
      _meta: {
        "io.modelcontextprotocol/serverInfo": {
          name: "vektor-mcp",
          version: "1.0.0",
        },
      },
    });
  });

  test("uses the modern tools/call parameter shape", async () => {
    const response = await handleMcpRequest(config, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        _meta: requestMeta,
        name: "list_documents",
        arguments: "{}",
      },
    });

    expect(response).toMatchObject({
      id: 4,
      error: { code: -32602 },
    });
  });

  test("rejects parameters that are outside the current RPC schemas", async () => {
    const response = await handleMcpRequest(config, {
      jsonrpc: "2.0",
      id: 5,
      method: "server/discover",
      params: { _meta: requestMeta, legacy: true },
    });

    expect(response).toMatchObject({
      id: 5,
      error: { code: -32602 },
    });
  });

  test("reports unknown tools as protocol errors", async () => {
    const response = await handleMcpRequest(config, {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        _meta: requestMeta,
        name: "missing_tool",
      },
    });

    expect(response).toMatchObject({
      id: 6,
      error: {
        code: -32602,
        message: "Unknown tool: missing_tool",
      },
    });
  });
});
