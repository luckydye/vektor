#!/usr/bin/env bun

/**
 * Vektor CLI
 *
 * Usage:
 *   vektor serve [--port <port>] [--host <host>] [--no-auth] [--in-memory] [--email-auth]
 *   vektor workflow run <docId> [--input key=value ...] [--json] [--url <url>] [--space <id>] [--token <tok>]
 *   vektor workflow logs <runId> [--url <url>] [--space <id>] [--token <tok>]
 *   vektor extension create <id>
 *   vektor extension package [id]
 *   vektor extension upload [id] --url <wiki-url> --space <space-id> --token <api-token>
 *   vektor cat <docId>
 *   vektor write <docId>
 *   vektor create [--slug <slug>] [--type <type>]
 *   vektor ls [--limit <n>]
 *   vektor query <query>
 */

import { commandAgent } from "./src/cli/agent.ts";
import {
  commandCat,
  commandCreate as commandDocCreate,
  commandLs,
  commandSearch,
  commandWrite,
} from "./src/cli/document.ts";
import { commandCreate, commandPackage, commandUpload } from "./src/cli/extension.ts";
import { resolveHost, resolveSpaceId } from "./src/cli/resolve.ts";
import { commandLogs, parseArgs, runWorkflow } from "./src/cli/workflow.ts";

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

function printUsage(): void {
  console.log(`
Usage:
  vektor serve [--port <port>] [--host <host>] [--no-auth] [--in-memory] [--email-auth]
  vektor agent [prompt...] [--doc <slug|id>] [--space <id>] [--url <host>] [--token <tok>] [--once]
  vektor workflow run <docId> [--input key=value ...] [--json] [--url <url>] [--space <id>] [--token <tok>]
  vektor workflow logs <runId> [--url <url>] [--space <id>] [--token <tok>]
  vektor extension create <id>
  vektor extension package [id]
  vektor extension upload [id] --url <wiki-url> --space <space-id> --token <api-token>
  vektor cat <docId>
  vektor write [<docId>] [--slug <slug>] [--type <type>]
  vektor ls [--limit <n>]
  vektor query <query>

Defaults to http://localhost:8080 and auto-discovers the first space.
Override with VEKTOR_HOST, VEKTOR_SPACE_ID, VEKTOR_ACCESS_TOKEN.
`);
}

async function main(): Promise<void> {
  const argv = Bun.argv.slice(2);
  const [command, ...rest] = argv;

  if (!command) {
    printUsage();
    process.exit(1);
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

  if (command === "agent") {
    const { positional, flags } = parseFlags(rest);
    await commandAgent({
      prompt: positional.length > 0 ? positional.join(" ") : undefined,
      doc: flags.doc,
      space: flags.space,
      url: flags.url,
      token: flags.token,
      user: flags.user,
      once: "once" in flags,
    });
    return;
  }

  if (command === "workflow") {
    const [subcommand, ...subArgs] = rest;

    if (subcommand === "logs") {
      const { positional, flags } = parseFlags(subArgs);
      if (!positional[0]) throw new Error("workflow logs requires a <runId>");
      await commandLogs(positional[0], { url: flags.url, spaceId: flags.space, token: flags.token });
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
      const { flags } = parseFlags(rest.slice(extensionId?.startsWith("--") ? 0 : 1));
      const url = flags.url ?? process.env.VEKTOR_URL ?? resolveHost();
      const token = flags.token ?? process.env.VEKTOR_TOKEN;
      const space = flags.space ?? (await resolveSpaceId(url, token));
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

  if (command === "write") {
    const { positional, flags } = parseFlags(rest);
    if (positional[0]) {
      await commandWrite(positional[0]);
    } else {
      await commandDocCreate({ slug: flags.slug, type: flags.type ?? "markdown" });
    }
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

  throw new Error(
    `Unknown command: ${command}\n\nTry: serve, workflow, extension, cat, write, ls, query`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
