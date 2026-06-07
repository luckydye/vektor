import { defineCommand } from "just-bash";
import { safeFetch, SsrfError } from "../../utils/ssrf.ts";

export const curlCommand = defineCommand("curl", async (args, ctx) => {
  let silent = false;
  let outputFile: string | null = null;
  let method = "GET";
  const headers: Record<string, string> = {};
  let body: string | null = null;
  let url: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-s" || arg === "--silent") { silent = true; continue; }
    if (arg === "-L" || arg === "--location") { continue; } // fetch follows redirects by default
    if (arg === "-o" || arg === "--output") { outputFile = args[++i] ?? null; continue; }
    if (arg === "-X" || arg === "--request") { method = args[++i] ?? "GET"; continue; }
    if (arg === "-H" || arg === "--header") {
      const raw = args[++i] ?? "";
      const colon = raw.indexOf(":");
      if (colon !== -1) headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
      continue;
    }
    if (arg === "-d" || arg === "--data") { body = args[++i] ?? null; if (method === "GET") method = "POST"; continue; }
    if (!arg.startsWith("-")) { url = arg; continue; }
  }

  if (!url) {
    return { stdout: "", stderr: "curl: no URL specified\nusage: curl [-s] [-o file] [-X method] [-H header] [-d data] <url>\n", exitCode: 2 };
  }

  let response: Response;
  try {
    response = await safeFetch(url, {
      method,
      headers,
      ...(body != null ? { body } : {}),
    });
  } catch (error) {
    if (error instanceof SsrfError) {
      return { stdout: "", stderr: `curl: ${error.message}\n`, exitCode: 6 };
    }
    throw error;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());

  if (!response.ok && !silent) {
    const text = Buffer.from(bytes).toString("utf-8");
    return { stdout: "", stderr: `curl: HTTP ${response.status}\n${text}\n`, exitCode: 22 };
  }

  if (outputFile) {
    const filePath = ctx.fs.resolvePath(ctx.cwd, outputFile);
    await ctx.fs.writeFile(filePath, bytes, "binary");
    if (!silent) {
      return { stdout: `  % Total\n100  ${bytes.length}\n`, stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  }

  return { stdout: Buffer.from(bytes).toString("utf-8"), stderr: "", exitCode: 0 };
});
