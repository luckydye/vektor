import { defineCommand } from "just-bash";
import { callTool as callVektorTool } from "../../utils/vektorMcp.ts";
import type { VektorMcpConfig } from "../../utils/vektorMcp.ts";

export function gitlabCommand(mcpConfigRef: { current: VektorMcpConfig }) {
  return defineCommand("gitlab", async (args, _ctx) => {
    const usage =
      "usage: gitlab [-X METHOD] [-H 'Header: value'] [-d data] <path-or-url>\n" +
      "examples:\n" +
      "  gitlab /user\n" +
      "  gitlab '/projects?membership=true&simple=true'\n" +
      "  gitlab -X POST -H 'Content-Type: application/json' -d '{\"title\":\"Bug\"}' /projects/123/issues\n";

    let method = "GET";
    const headers: Record<string, string> = {};
    let body: string | undefined;
    let path: string | undefined;

    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === "-X" || arg === "--request") {
        method = (args[++index] ?? "").toUpperCase();
        continue;
      }
      if (arg === "-H" || arg === "--header") {
        const raw = args[++index] ?? "";
        const colon = raw.indexOf(":");
        if (colon !== -1) {
          headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
        }
        continue;
      }
      if (arg === "-d" || arg === "--data") {
        body = args[++index] ?? "";
        if (method === "GET") method = "POST";
        continue;
      }
      if (!arg.startsWith("-")) {
        path = arg;
        continue;
      }
    }

    if (!path) {
      return { stdout: "", stderr: usage, exitCode: 2 };
    }

    const result = (await callVektorTool(mcpConfigRef.current, "integration_api_request", {
      provider: "gitlab",
      method,
      path,
      headers,
      body,
    })) as {
      ok?: boolean;
      status?: number;
      statusText?: string;
      body?: string;
    };

    const responseBody = result.body ?? "";
    if (!result.ok) {
      return {
        stdout: "",
        stderr: `gitlab: HTTP ${result.status ?? "unknown"} ${result.statusText ?? ""}\n${responseBody}\n`,
        exitCode: 22,
      };
    }

    return {
      stdout: responseBody.endsWith("\n") ? responseBody : `${responseBody}\n`,
      stderr: "",
      exitCode: 0,
    };
  });
}
