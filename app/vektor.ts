#!/usr/bin/env bun

/**
 * Vektor CLI
 *
 * Usage:
 *   vektor serve [--port <port>] [--host <host>] [--no-auth] [--email-auth]
 *   vektor workflow <docId> [--input key=value ...] [--json] [--url <url>] [--space <id>] [--token <tok>]
 *   vektor extension create <id>
 *   vektor extension package [id]
 *   vektor extension upload [id] --url <wiki-url> --space <space-id> --token <api-token>
 *   vektor document cat <docId>
 *   vektor document write <docId>
 *   vektor document create [--slug <slug>] [--type <type>]
 *   vektor document ls [--limit <n>]
 *   vektor document search <query>
 */

import { parseArgs, runWorkflow } from "../cli/src/workflow.ts";
import { commandCreate, commandPackage, commandUpload } from "../cli/src/extension.ts";
import {
  commandCat,
  commandWrite,
  commandCreate as commandDocCreate,
  commandLs,
  commandSearch,
} from "../cli/src/document.ts";

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
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
  vektor serve [--port <port>] [--host <host>] [--no-auth] [--email-auth]
  vektor workflow <docId> [--input key=value ...] [--json] [--url <url>] [--space <id>] [--token <tok>]
  vektor extension create <id>
  vektor extension package [id]
  vektor extension upload [id] --url <wiki-url> --space <space-id> --token <api-token>
  vektor document cat <docId>
  vektor document write <docId>
  vektor document create [--slug <slug>] [--type <type>]
  vektor document ls [--limit <n>]
  vektor document search <query>

Document commands require: WIKI_HOST, WIKI_SPACE_ID, WIKI_ACCESS_TOKEN (optional)
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
    await import("./src/server.ts");
    return;
  }

  if (command === "workflow") {
    const options = parseArgs(rest);
    const result = await runWorkflow(options);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    for (const [nodeId, node] of Object.entries(result.nodes)) {
      process.stdout.write(`${nodeId}: ${node.status}${node.error ? ` — ${node.error}` : ""}\n`);
    }
    if (result.output) {
      process.stdout.write(`Output: ${JSON.stringify(result.output, null, 2)}\n`);
    }
    if (result.status === "failed") process.exit(1);
    return;
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
      const url = flags.url ?? process.env.WIKI_URL;
      const space = flags.space ?? process.env.WIKI_SPACE_ID;
      const token = flags.token ?? process.env.WIKI_TOKEN;
      if (!url) throw new Error("--url is required (or set WIKI_URL)");
      if (!space) throw new Error("--space is required (or set WIKI_SPACE_ID)");
      if (!token) throw new Error("--token is required (or set WIKI_TOKEN)");
      await commandUpload(extensionId?.startsWith("--") ? undefined : extensionId, url, space, token);
      return;
    }

    throw new Error(`Unknown extension subcommand: ${subcommand}\n\nTry: create, package, upload`);
  }

  if (command === "document") {
    const { positional, flags } = parseFlags(rest);
    const [subcommand, ...subArgs] = positional;

    if (subcommand === "cat") {
      if (!subArgs[0]) throw new Error("document cat requires a <docId>");
      await commandCat(subArgs[0]);
      return;
    }

    if (subcommand === "write") {
      if (!subArgs[0]) throw new Error("document write requires a <docId>");
      await commandWrite(subArgs[0]);
      return;
    }

    if (subcommand === "create") {
      await commandDocCreate({ slug: flags.slug, type: flags.type });
      return;
    }

    if (subcommand === "ls") {
      await commandLs({ limit: flags.limit });
      return;
    }

    if (subcommand === "search") {
      if (!subArgs[0]) throw new Error("document search requires a <query>");
      await commandSearch(subArgs.join(" "));
      return;
    }

    throw new Error(`Unknown document subcommand: ${subcommand}\n\nTry: cat, write, create, ls, search`);
  }

  throw new Error(`Unknown command: ${command}\n\nTry: serve, workflow, extension, document`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
