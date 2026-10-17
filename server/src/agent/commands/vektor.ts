import { defineCommand } from "just-bash";
import { callTool, listTools, type VektorMcpConfig } from "#agent/tools.ts";

const usage =
  "usage: vektor <tool> [json-arguments]   (arguments are read from stdin when omitted)\n" +
  "       vektor <tool> --help             (the tool's argument schema)\n";

/** The structured Vektor tools, callable from scripts: the same registry, no second implementation. */
export function vektorCommand(mcpConfigRef: { current: VektorMcpConfig }) {
  return defineCommand("vektor", async (args, ctx) => {
    const [name, rawArguments] = args;
    const tools = await listTools(mcpConfigRef.current);
    if (!name || name === "--help") {
      const list = tools.map((tool) => `  ${tool.name}  ${tool.description}\n`).join("");
      return { stdout: `${usage}\n${list}`, stderr: "", exitCode: name ? 0 : 2 };
    }

    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return { stdout: "", stderr: `vektor: unknown tool "${name}"\n${usage}`, exitCode: 2 };
    }
    if (rawArguments === "--help") {
      return {
        stdout: `${tool.description}\n${JSON.stringify(tool.inputSchema, null, 2)}\n`,
        stderr: "",
        exitCode: 0,
      };
    }

    const json = (rawArguments ?? ctx.stdin).trim() || "{}";
    try {
      const result = await callTool(mcpConfigRef.current, name, JSON.parse(json));
      return { stdout: `${JSON.stringify(result)}\n`, stderr: "", exitCode: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: "", stderr: `vektor ${name}: ${message}\n`, exitCode: 1 };
    }
  });
}
