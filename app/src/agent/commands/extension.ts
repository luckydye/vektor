import { posix } from "node:path";
import { defineCommand } from "just-bash";
import type { VektorMcpConfig } from "../../utils/vektorMcp.ts";
import { callTool as callVektorTool } from "../../utils/vektorMcp.ts";

export function extensionCommand(mcpConfigRef: { current: VektorMcpConfig }) {
  return defineCommand("extension", async (args, ctx) => {
    const usage = "usage: extension install <zip-file>\n";
    const [subcommand, fileArg] = args;

    if (subcommand !== "install" || !fileArg) {
      return { stdout: "", stderr: usage, exitCode: 2 };
    }

    const filePath = ctx.fs.resolvePath(ctx.cwd, fileArg);
    if (!(await ctx.fs.exists(filePath))) {
      return {
        stdout: "",
        stderr: `extension: ${fileArg}: No such file or directory\n`,
        exitCode: 1,
      };
    }

    const bytes = await ctx.fs.readFileBuffer(filePath);
    const content = Buffer.from(bytes).toString("base64");
    const filename = posix.basename(filePath);

    const result = await callVektorTool(mcpConfigRef.current, "install_extension", {
      filename,
      content,
    });

    return {
      stdout: `${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`,
      stderr: "",
      exitCode: 0,
    };
  });
}
