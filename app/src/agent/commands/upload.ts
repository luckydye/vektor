import { defineCommand } from "just-bash";
import { posix } from "node:path";
import { callTool as callVektorTool } from "../../utils/vektorMcp.ts";
import type { VektorMcpConfig } from "../../utils/vektorMcp.ts";

export function uploadCommand(mcpConfigRef: { current: VektorMcpConfig }) {
  return defineCommand("upload", async (args, ctx) => {
    const usage = "usage: upload <file> [-t content-type] [-d document-id]\n";

    let contentType: string | undefined;
    let documentId: string | undefined;
    let fileArg: string | undefined;

    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "-t") {
        contentType = args[++index];
        continue;
      }
      if (arg === "-d") {
        documentId = args[++index];
        continue;
      }
      fileArg = arg;
    }

    if (!fileArg) {
      return { stdout: "", stderr: usage, exitCode: 2 };
    }

    const filePath = ctx.fs.resolvePath(ctx.cwd, fileArg);
    if (!(await ctx.fs.exists(filePath))) {
      return { stdout: "", stderr: `upload: ${fileArg}: No such file or directory\n`, exitCode: 1 };
    }

    const bytes = await ctx.fs.readFileBuffer(filePath);
    const content = Buffer.from(bytes).toString("base64");
    const filename = posix.basename(filePath);

    const result = await callVektorTool(mcpConfigRef.current, "upload_artifact", {
      filename,
      content,
      encoding: "base64",
      ...(contentType ? { contentType } : {}),
      ...(documentId ? { documentId } : {}),
    });

    return {
      stdout: `${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`,
      stderr: "",
      exitCode: 0,
    };
  });
}
