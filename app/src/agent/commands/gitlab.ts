import { defineCommand } from "just-bash";
import { callTool as callVektorTool } from "../../utils/vektorMcp.ts";
import type { VektorMcpConfig } from "../../utils/vektorMcp.ts";

async function gitlabApiRequest(
  mcpConfigRef: { current: VektorMcpConfig },
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
) {
  return (await callVektorTool(mcpConfigRef.current, "integration_api_request", {
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
}

function encodeProject(project: string) {
  // Accept numeric IDs as-is; encode namespace/project paths.
  return /^\d+$/.test(project) ? project : encodeURIComponent(project);
}

interface TreeEntry {
  id: string;
  name: string;
  type: "blob" | "tree";
  path: string;
  mode: string;
}

function buildTree(entries: TreeEntry[], prefix = ""): string {
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const isLast = i === entries.length - 1;
    const connector = isLast ? "└── " : "├── ";
    const name = entry.type === "tree" ? `${entry.name}/` : entry.name;
    lines.push(`${prefix}${connector}${name}`);
  }
  return lines.join("\n");
}

export function gitlabCommand(mcpConfigRef: { current: VektorMcpConfig }) {
  return defineCommand("gitlab", async (args, _ctx) => {
    const usage =
      "usage:\n" +
      "  gitlab api [-X METHOD] [-H 'Header: value'] [-d data] <path>\n" +
      "  gitlab ls <project> [path] [--ref <ref>]\n" +
      "  gitlab cat <project> <file-path> [--ref <ref>]\n" +
      "  gitlab tree <project> [path] [--ref <ref>]\n" +
      "examples:\n" +
      "  gitlab api /user\n" +
      "  gitlab api '/projects?membership=true&simple=true'\n" +
      "  gitlab ls group/project src/\n" +
      "  gitlab cat group/project README.md --ref main\n" +
      "  gitlab tree group/project --ref develop\n";

    const subcommand = args[0];

    if (!subcommand) {
      return { stdout: "", stderr: usage, exitCode: 2 };
    }

    // --- ls / cat / tree sub-commands ---
    if (subcommand === "ls" || subcommand === "cat" || subcommand === "tree") {
      const project = args[1];
      if (!project || project.startsWith("-")) {
        return {
          stdout: "",
          stderr:
            `gitlab ${subcommand}: missing <project> (must be a numeric ID or namespace/project path).\n` +
            `To list or search projects use: gitlab '/projects?search=name'\n`,
          exitCode: 2,
        };
      }

      let filePath = "";
      let ref = "HEAD";

      for (let i = 2; i < args.length; i++) {
        const arg = args[i]!;
        if ((arg === "--ref" || arg === "-r") && args[i + 1]) {
          ref = args[++i]!;
        } else if (!arg.startsWith("-")) {
          filePath = arg;
        }
      }

      const encodedProject = encodeProject(project);

      if (subcommand === "cat") {
        if (!filePath) {
          return { stdout: "", stderr: `gitlab cat: missing <file-path>\n${usage}`, exitCode: 2 };
        }
        const encodedPath = encodeURIComponent(filePath);
        const result = await gitlabApiRequest(
          mcpConfigRef,
          "GET",
          `/projects/${encodedProject}/repository/files/${encodedPath}/raw?ref=${encodeURIComponent(ref)}`,
        );
        if (!result.ok) {
          return {
            stdout: "",
            stderr: `gitlab cat: HTTP ${result.status ?? "unknown"} ${result.statusText ?? ""}\n${result.body ?? ""}\n`,
            exitCode: 22,
          };
        }
        const body = result.body ?? "";
        return { stdout: body.endsWith("\n") ? body : `${body}\n`, stderr: "", exitCode: 0 };
      }

      // ls and tree share the repository tree API
      const recursive = subcommand === "tree";
      const qs = new URLSearchParams({ ref, per_page: "100", pagination: "keyset" });
      if (filePath) qs.set("path", filePath);
      if (recursive) qs.set("recursive", "true");

      const result = await gitlabApiRequest(
        mcpConfigRef,
        "GET",
        `/projects/${encodedProject}/repository/tree?${qs.toString()}`,
      );

      if (!result.ok) {
        return {
          stdout: "",
          stderr: `gitlab ${subcommand}: HTTP ${result.status ?? "unknown"} ${result.statusText ?? ""}\n${result.body ?? ""}\n`,
          exitCode: 22,
        };
      }

      let entries: TreeEntry[] = [];
      try {
        entries = JSON.parse(result.body ?? "[]") as TreeEntry[];
      } catch {
        return { stdout: "", stderr: `gitlab ${subcommand}: failed to parse response\n`, exitCode: 1 };
      }

      if (subcommand === "ls") {
        const lines = entries.map((e) => (e.type === "tree" ? `${e.name}/` : e.name));
        const out = lines.join("\n");
        return { stdout: out ? `${out}\n` : "", stderr: "", exitCode: 0 };
      }

      // tree: render as indented tree grouped under their parent paths
      const root = filePath ? `${filePath}/` : `${project}/`;
      const out = `${root}\n${buildTree(entries)}`;
      return { stdout: `${out}\n`, stderr: "", exitCode: 0 };
    }

    // --- api sub-command: raw API request ---
    if (subcommand !== "api") {
      return { stdout: "", stderr: `gitlab: unknown sub-command '${subcommand}'\n${usage}`, exitCode: 2 };
    }

    let method = "GET";
    const headers: Record<string, string> = {};
    let body: string | undefined;
    let path: string | undefined;

    for (let index = 1; index < args.length; index++) {
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
      return { stdout: "", stderr: `usage: gitlab api [-X METHOD] [-H 'Header: value'] [-d data] <path>\n`, exitCode: 2 };
    }

    const result = await gitlabApiRequest(mcpConfigRef, method, path, headers, body);

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
