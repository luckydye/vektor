#!/usr/bin/env bun

/**
 * Vektor CLI
 *
 * Usage:
 *   vektor login
 *   vektor serve [--port <port>] [--host <host>] [--no-auth] [--in-memory] [--email-auth]
 *   vektor mcp
 *   vektor agent [prompt...] [--doc <slug|id>] [--once]
 *   vektor workflow run <docId> [--input key=value ...] [--json]
 *   vektor workflow logs <runId>
 *   vektor extension create <id>
 *   vektor extension package [id]
 *   vektor extension upload [id]
 *   vektor cat <docId>
 *   vektor upload <file> [--filename <name>] [--document <docId>] [--content-type <mime>] [--json]
 *   vektor write [<docId>] [<file>|-] [--slug <slug>] [--title <title>] [--category <slug>] [--created <date>] [--modified <date>] [--type <type>] [--parent <docId>]
 *   vektor ls [--limit <n>]
 *   vektor query <query>
 *   vektor set <docId> [key=value ...] [-key ...] [--title <title>] [--category <slug>] [--parent <docId|->]
 *   vektor category ls
 *   vektor category create <name> [--slug <slug>] [--description <desc>] [--color <color>] [--icon <icon>]
 *   vektor category edit <slug> [--name <name>] [--slug <slug>] [--description <desc>] [--color <color>] [--icon <icon>]
 *   vektor category rm <slug>
 */

import { commandAgent } from "./src/cli/agent.ts";
import {
  commandCategoryCreate,
  commandCategoryEdit,
  commandCategoryLs,
  commandCategoryRm,
} from "./src/cli/category.ts";
import {
  commandCat,
  commandCreate as commandDocCreate,
  commandLs,
  commandSearch,
  commandSet,
  commandWrite,
} from "./src/cli/document.ts";
import { commandCreate, commandPackage, commandUpload } from "./src/cli/extension.ts";
import { commandLogin } from "./src/cli/login.ts";
import { commandMcp } from "./src/cli/mcp.ts";
import { resolveHost, resolveSpaceId } from "./src/cli/resolve.ts";
import { commandUploadFile } from "./src/cli/upload.ts";
import { commandLogs, parseArgs, runWorkflow } from "./src/cli/workflow.ts";
import { config } from "./src/config.ts";

function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string>;
} {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (!next || next.startsWith("--")) {
        flags[key] = "true";
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

function stripFlag(
  argv: string[],
  flag: string,
): { argv: string[]; value: string | undefined } {
  const result: string[] = [];
  let value: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${flag}` && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      value = argv[++i];
    } else {
      result.push(argv[i]);
    }
  }
  return { argv: result, value };
}

function printUsage(): void {
  console.log(`
Usage:
  vektor [--space <id>] <command> [args]

Commands:
  vektor login
  vektor serve [--port <port>] [--host <host>] [--no-auth] [--in-memory] [--email-auth]
  vektor mcp
  vektor agent [prompt...] [--doc <slug|id>] [--once]
  vektor workflow run <docId> [--input key=value ...] [--json]
  vektor workflow logs <runId>
  vektor extension create <id>
  vektor extension package [id]
  vektor extension upload [id]
  vektor cat <docId>
  vektor upload <file> [--filename <name>] [--document <docId>] [--content-type <mime>] [--json]
  vektor write [<docId>] [<file>|-] [--slug <slug>] [--title <title>] [--category <slug>] [--created <date>] [--modified <date>] [--type <type>] [--parent <docId>]
  vektor ls [--limit <n>]
  vektor query <query>
  vektor set <docId> [key=value ...] [-key ...] [--title <title>] [--category <slug>] [--parent <docId|->]
  vektor category ls
  vektor category create <name> [--slug <slug>] [--description <desc>] [--color <color>] [--icon <icon>]
  vektor category edit <slug> [--name <name>] [--slug <slug>] [--description <desc>] [--color <color>] [--icon <icon>]
  vektor category rm <slug>

Env vars:
  VEKTOR_HOST           Server URL (default: http://localhost:8080)
  VEKTOR_SPACE_ID       Space to use (default: first space on server)
  VEKTOR_ACCESS_TOKEN   API token (required if auth is enabled; used by vektor mcp)
`);
}

async function main(): Promise<void> {
  let argv = Bun.argv.slice(2);

  // Global flags resolved before routing.
  const { argv: argvAfterSpace, value: spaceFlag } = stripFlag(argv, "space");
  if (spaceFlag) process.env.VEKTOR_SPACE_ID = spaceFlag;
  argv = argvAfterSpace;

  const [command, ...rest] = argv;

  if (command === "--version" || command === "-v") {
    const { version } = await import("./package.json");
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    process.exit(command ? 0 : 1);
  }

  if (command === "login") {
    await commandLogin();
    return;
  }

  if (command === "serve") {
    const { flags } = parseFlags(rest);
    if (flags.port) process.argv.push("--port", flags.port);
    if (flags.host) process.env.HOST = flags.host;
    if ("no-auth" in flags) process.env.VEKTOR_NO_AUTH = "1";
    if ("email-auth" in flags) process.env.VEKTOR_EMAIL_AUTH = "1";
    if ("in-memory" in flags) process.env.VEKTOR_IN_MEMORY_DB = "1";
    await import("./src/server.ts");
    return;
  }

  if (command === "mcp") {
    await commandMcp();
    return;
  }

  if (command === "agent") {
    const { positional, flags } = parseFlags(rest);
    await commandAgent({
      prompt: positional.length > 0 ? positional.join(" ") : undefined,
      doc: flags.doc,
      once: "once" in flags,
    });
    return;
  }

  if (command === "workflow") {
    const [subcommand, ...subArgs] = rest;

    if (subcommand === "logs") {
      const { positional, flags } = parseFlags(subArgs);
      if (!positional[0]) throw new Error("workflow logs requires a <runId>");
      await commandLogs(positional[0]);
      return;
    }

    if (subcommand === "run") {
      const options = parseArgs(subArgs);
      const result = await runWorkflow(options);

      if (options.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      for (const [nodeId, node] of Object.entries(result.nodes)) {
        process.stdout.write(
          `${nodeId}: ${node.status}${node.error ? ` — ${node.error}` : ""}\n`,
        );
      }
      if (result.output) {
        process.stdout.write(`Output: ${JSON.stringify(result.output, null, 2)}\n`);
      }
      if (result.status === "failed") process.exit(1);
      return;
    }

    throw new Error(`Unknown workflow subcommand: ${subcommand}\n\nTry: run, logs`);
  }

  if (command === "extension") {
    const [subcommand, extensionId] = rest;

    if (subcommand === "create") {
      if (!extensionId) throw new Error("extension create requires an <id>");
      commandCreate(extensionId);
      return;
    }

    if (subcommand === "package") {
      await commandPackage(extensionId);
      return;
    }

    if (subcommand === "upload") {
      const url = resolveHost();
      const token = config().CLI_ACCESS_TOKEN;
      const space = await resolveSpaceId(url, token);
      await commandUpload(
        extensionId?.startsWith("--") ? undefined : extensionId,
        url,
        space,
        token!,
      );
      return;
    }

    throw new Error(
      `Unknown extension subcommand: ${subcommand}\n\nTry: create, package, upload`,
    );
  }

  if (command === "cat") {
    if (!rest[0]) throw new Error("cat requires a <docId>");
    await commandCat(rest[0]);
    return;
  }

  if (command === "upload") {
    const { positional, flags } = parseFlags(rest);
    if (!positional[0]) throw new Error("upload requires a <file>");
    await commandUploadFile({
      source: positional[0],
      filename: flags.filename,
      documentId: flags.document ?? flags["document-id"],
      contentType: flags["content-type"],
      json: "json" in flags,
    });
    return;
  }

  if (command === "write") {
    const { positional, flags } = parseFlags(rest);
    const isDocId =
      positional[0] &&
      !positional[0].includes("/") &&
      !positional[0].includes(".") &&
      positional[0] !== "-";
    if (isDocId) {
      await commandWrite(positional[0], positional[1]);
    } else {
      const properties: Record<string, string> = {};
      if (flags.title) properties.title = flags.title;
      if (flags.category) properties.category = flags.category;
      await commandDocCreate({
        slug: flags.slug,
        type: flags.type,
        source: positional[0],
        parent: flags.parent,
        created: flags.created,
        modified: flags.modified,
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
      });
    }
    return;
  }

  if (command === "set") {
    const { positional, flags } = parseFlags(rest);
    const [docId, ...assignments] = positional;
    if (!docId) throw new Error("set requires a <docId>");
    await commandSet(docId, assignments, {
      parent: flags.parent,
      title: flags.title,
      category: flags.category,
    });
    return;
  }

  if (command === "ls" || command === "list") {
    const { flags } = parseFlags(rest);
    await commandLs({ limit: flags.limit });
    return;
  }

  if (command === "query") {
    if (!rest[0]) throw new Error("query requires a <query>");
    await commandSearch(rest.join(" "));
    return;
  }

  if (command === "category") {
    const [subcommand, ...subArgs] = rest;

    if (subcommand === "ls" || subcommand === "list") {
      await commandCategoryLs();
      return;
    }

    if (subcommand === "create") {
      const { positional, flags } = parseFlags(subArgs);
      const name = positional.join(" ") || flags.name;
      if (!name) throw new Error("category create requires a <name>");
      await commandCategoryCreate({
        name,
        slug: flags.slug,
        description: flags.description,
        color: flags.color,
        icon: flags.icon,
      });
      return;
    }

    if (subcommand === "edit") {
      const { positional, flags } = parseFlags(subArgs);
      if (!positional[0]) throw new Error("category edit requires a <slug>");
      await commandCategoryEdit(positional[0], {
        name: flags.name,
        slug: flags.slug,
        description: flags.description,
        color: flags.color,
        icon: flags.icon,
      });
      return;
    }

    if (subcommand === "rm" || subcommand === "delete") {
      if (!subArgs[0]) throw new Error("category rm requires a <slug>");
      await commandCategoryRm(subArgs[0]);
      return;
    }

    throw new Error(
      `Unknown category subcommand: ${subcommand}\n\nTry: ls, create, edit, rm`,
    );
  }

  throw new Error(
    `Unknown command: ${command}\n\nTry: serve, mcp, workflow, extension, cat, upload, write, set, ls, query, category`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
