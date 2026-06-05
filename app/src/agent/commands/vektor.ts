import { defineCommand } from "just-bash";
import { callTool as callVektorTool } from "../../utils/vektorMcp.ts";
import type { VektorMcpConfig } from "../../utils/vektorMcp.ts";

function formatVektorValue(value: unknown, json: boolean): string {
  if (json || typeof value === "string") {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatVektorValue(item, false)).join("\n\n");
  }

  if (!value || typeof value !== "object") {
    return String(value);
  }

  const record = value as Record<string, unknown>;

  if (Array.isArray(record.documents)) {
    return record.documents
      .map((item, index) => {
        const doc = item as Record<string, unknown>;
        const title =
          typeof doc.title === "string"
            ? doc.title
            : typeof doc.slug === "string"
              ? doc.slug
              : `document-${index + 1}`;
        const lines = [title];
        if (typeof doc.id === "string") lines.push(`id: ${doc.id}`);
        if (typeof doc.slug === "string") lines.push(`slug: ${doc.slug}`);
        if (typeof doc.type === "string") lines.push(`type: ${doc.type}`);
        return lines.join("\n");
      })
      .join("\n\n");
  }

  const title =
    typeof record.title === "string"
      ? record.title
      : typeof record.slug === "string"
        ? record.slug
        : null;
  const lines: string[] = [];
  if (title) lines.push(title);
  if (typeof record.id === "string") lines.push(`id: ${record.id}`);
  if (typeof record.slug === "string") lines.push(`slug: ${record.slug}`);
  if (typeof record.type === "string") lines.push(`type: ${record.type}`);
  if (typeof record.content === "string") {
    lines.push("");
    lines.push(record.content);
  }
  if (lines.length > 0) {
    return lines.join("\n");
  }

  return JSON.stringify(record, null, 2);
}

export function vektorCommand(mcpConfigRef: { current: VektorMcpConfig }) {
  return defineCommand("vektor", async (args, _ctx) => {
    const json = args.includes("--json");
    const commandArgs = args.filter((arg) => arg !== "--json");
    const [subcommand, ...rest] = commandArgs;

    if (!subcommand) {
      return {
        stdout: "",
        stderr:
          "usage: vektor <list|read|current|search|create|delete|workflow> [args] [--json]\n" +
          "fetch other docs: vektor search \"query\" --json -> take id -> vektor read <id>\n" +
          "fetch current doc: vektor current\n" +
          "create doc: vektor create --title \"Title\" [--type type] [--parent document-id] [file]\n" +
          "archive doc: vektor delete <id>\n" +
          "permanently delete doc: vektor delete <id> --permanent\n" +
          "save to file: vektor read <id> > doc.md\n" +
          "workflow: vektor workflow run <document-id> [--inputs '{...}']\n" +
          "          vektor workflow status <run-id>\n" +
          "          vektor workflow logs <run-id> [--node <node-id>]\n" +
          "          vektor workflow list [--document-id <id>]\n",
        exitCode: 2,
      };
    }

    let result: unknown;
    switch (subcommand) {
      case "list":
        result = await callVektorTool(mcpConfigRef.current, "list_documents", {});
        break;
      case "read": {
        if (!rest[0]) {
          return {
            stdout: "",
            stderr: "usage: vektor read <document-id> [--json]\n",
            exitCode: 2,
          };
        }
        result = await callVektorTool(mcpConfigRef.current, "read_document", {
          documentId: rest[0],
        });
        if (!json) {
          const doc = (result as Record<string, unknown>)?.document as Record<string, unknown> | undefined;
          const html = typeof doc?.content === "string" ? doc.content : null;
          if (html !== null) {
            return { stdout: `${html}\n`, stderr: "", exitCode: 0 };
          }
        }
        break;
      }
      case "current": {
        result = await callVektorTool(mcpConfigRef.current, "get_current_document", {});
        if (!json) {
          const doc = (result as Record<string, unknown>)?.document as Record<string, unknown> | undefined;
          const html = typeof doc?.content === "string" ? doc.content : null;
          if (html !== null) {
            return { stdout: `${html}\n`, stderr: "", exitCode: 0 };
          }
        }
        break;
      }
      case "search":
        if (!rest.length) {
          return {
            stdout: "",
            stderr: "usage: vektor search <query> [--json]\n",
            exitCode: 2,
          };
        }
        result = await callVektorTool(mcpConfigRef.current, "search_documents", {
          q: rest.join(" "),
        });
        break;
      case "create": {
        const usage =
          "usage: vektor create --title <title> [--type type] [--parent document-id] [file] [--json]\n";
        let title: string | undefined;
        let type: string | undefined;
        let parentId: string | undefined;
        let fileArg: string | undefined;

        for (let index = 0; index < rest.length; index++) {
          const arg = rest[index]!;
          if (arg === "--title" || arg === "-t") {
            title = rest[++index];
            continue;
          }
          if (arg === "--type") {
            type = rest[++index];
            continue;
          }
          if (arg === "--parent" || arg === "--parent-id") {
            parentId = rest[++index];
            continue;
          }
          if (!arg.startsWith("-")) {
            fileArg = arg;
            continue;
          }
          return {
            stdout: "",
            stderr: `vektor create: unknown flag '${arg}'\n${usage}`,
            exitCode: 2,
          };
        }

        if (!title?.trim()) {
          return { stdout: "", stderr: usage, exitCode: 2 };
        }

        let content: string;
        if (fileArg) {
          const filePath = _ctx.fs.resolvePath(_ctx.cwd, fileArg);
          if (!(await _ctx.fs.exists(filePath))) {
            return {
              stdout: "",
              stderr: `vektor create: ${fileArg}: No such file or directory\n`,
              exitCode: 1,
            };
          }
          content = Buffer.from(await _ctx.fs.readFileBuffer(filePath)).toString("utf-8");
        } else {
          content = _ctx.stdin;
        }

        if (!content.trim()) {
          return {
            stdout: "",
            stderr: "vektor create: content is required from file or stdin\n",
            exitCode: 2,
          };
        }

        result = await callVektorTool(mcpConfigRef.current, "write_document", {
          title,
          content,
          ...(type ? { type } : {}),
          ...(parentId ? { parentId } : {}),
        });

        if (!json) {
          const doc = (result as Record<string, unknown>)?.document as
            | Record<string, unknown>
            | undefined;
          const id = typeof doc?.id === "string" ? doc.id : null;
          const slug = typeof doc?.slug === "string" ? doc.slug : null;
          return {
            stdout: `created ${id ?? "document"}${slug ? ` ${slug}` : ""}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        break;
      }
      case "update": {
        const usage = "usage: vektor update <document-id> [file] [--json]\n";
        const [documentId, ...updateRest] = rest;
        if (!documentId) {
          return { stdout: "", stderr: usage, exitCode: 2 };
        }

        let fileArg: string | undefined;
        for (const arg of updateRest) {
          if (!arg.startsWith("-")) {
            fileArg = arg;
          } else {
            return {
              stdout: "",
              stderr: `vektor update: unknown flag '${arg}'\n${usage}`,
              exitCode: 2,
            };
          }
        }

        let content: string;
        if (fileArg) {
          const filePath = _ctx.fs.resolvePath(_ctx.cwd, fileArg);
          if (!(await _ctx.fs.exists(filePath))) {
            return {
              stdout: "",
              stderr: `vektor update: ${fileArg}: No such file or directory\n`,
              exitCode: 1,
            };
          }
          content = Buffer.from(await _ctx.fs.readFileBuffer(filePath)).toString("utf-8");
        } else {
          content = _ctx.stdin;
        }

        if (!content.trim()) {
          return {
            stdout: "",
            stderr: "vektor update: content is required from file or stdin\n",
            exitCode: 2,
          };
        }

        result = await callVektorTool(mcpConfigRef.current, "write_document", {
          documentId,
          content,
        });

        if (!json) {
          return {
            stdout: `updated ${documentId}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        break;
      }
      case "delete": {
        const [documentId, ...flags] = rest;
        if (!documentId) {
          return {
            stdout: "",
            stderr: "usage: vektor delete <document-id> [--permanent] [--json]\n",
            exitCode: 2,
          };
        }
        const invalidFlag = flags.find((flag) => flag !== "--permanent");
        if (invalidFlag) {
          return {
            stdout: "",
            stderr: `vektor delete: unknown flag '${invalidFlag}'\n`,
            exitCode: 2,
          };
        }
        const permanent = flags.includes("--permanent");
        result = await callVektorTool(mcpConfigRef.current, "delete_document", {
          documentId,
          permanent,
        });
        if (!json) {
          return {
            stdout: `${permanent ? "deleted" : "archived"} ${documentId}\n`,
            stderr: "",
            exitCode: 0,
          };
        }
        break;
      }
      case "workflow": {
        const [wfSubcommand, ...wfRest] = rest;
        switch (wfSubcommand) {
          case "run": {
            const documentId = wfRest[0];
            if (!documentId) {
              return {
                stdout: "",
                stderr: "usage: vektor workflow run <document-id> [--inputs '{...}']\n",
                exitCode: 2,
              };
            }
            let inputs: Record<string, unknown> | undefined;
            for (let i = 1; i < wfRest.length; i++) {
              if (wfRest[i] === "--inputs") {
                try {
                  inputs = JSON.parse(wfRest[++i] ?? "{}") as Record<string, unknown>;
                } catch {
                  return { stdout: "", stderr: "vektor workflow run: --inputs must be valid JSON\n", exitCode: 2 };
                }
                break;
              }
            }
            result = await callVektorTool(mcpConfigRef.current, "run_workflow", {
              documentId,
              ...(inputs ? { inputs } : {}),
            });
            if (!json) {
              const run = (result as Record<string, unknown>)?.run as Record<string, unknown> | undefined;
              const runId = typeof run?.id === "string" ? run.id : null;
              return { stdout: `started workflow run ${runId ?? ""}\n`, stderr: "", exitCode: 0 };
            }
            break;
          }
          case "status": {
            const runId = wfRest[0];
            if (!runId) {
              return {
                stdout: "",
                stderr: "usage: vektor workflow status <run-id>\n",
                exitCode: 2,
              };
            }
            result = await callVektorTool(mcpConfigRef.current, "get_workflow_run", { runId });
            break;
          }
          case "logs": {
            const runId = wfRest[0];
            if (!runId) {
              return {
                stdout: "",
                stderr: "usage: vektor workflow logs <run-id> [--node <node-id>]\n",
                exitCode: 2,
              };
            }
            let nodeId: string | undefined;
            for (let i = 1; i < wfRest.length; i++) {
              if (wfRest[i] === "--node") {
                nodeId = wfRest[++i];
                break;
              }
            }
            result = await callVektorTool(mcpConfigRef.current, "get_workflow_log", {
              runId,
              ...(nodeId ? { nodeId } : {}),
            });
            break;
          }
          case "list": {
            let documentId: string | undefined;
            for (let i = 0; i < wfRest.length; i++) {
              if (wfRest[i] === "--document-id") {
                documentId = wfRest[++i];
                break;
              }
            }
            result = await callVektorTool(mcpConfigRef.current, "list_workflow_runs", {
              ...(documentId ? { documentId } : {}),
            });
            break;
          }
          default:
            return {
              stdout: "",
              stderr:
                "usage: vektor workflow <run|status|logs|list> [args]\n" +
                "  run <document-id> [--inputs '{...}']\n" +
                "  status <run-id>\n" +
                "  logs <run-id> [--node <node-id>]\n" +
                "  list [--document-id <id>]\n",
              exitCode: 2,
            };
        }
        break;
      }
      default:
        return {
          stdout: "",
          stderr: `vektor: unknown subcommand '${subcommand}'\nusage: vektor <list|read|current|search|create|update|delete|workflow> [args] [--json]\n`,
          exitCode: 2,
        };
    }

    return {
      stdout: `${formatVektorValue(result, json)}\n`,
      stderr: "",
      exitCode: 0,
    };
  });
}
