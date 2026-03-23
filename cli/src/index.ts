#!/usr/bin/env bun

/**
 * Wiki CLI
 *
 * Usage:
 *   bun cli/src/index.ts workflow <workflow.json> --extension <path> [--extension <path>...] [--json] [--timeout-ms <ms>]
 *   bun cli/src/index.ts extension create <id>
 *   bun cli/src/index.ts extension package [id]
 *   bun cli/src/index.ts extension upload [id] --url <wiki-url> --space <space-id> --token <api-token>
 *
 * Examples:
 *   bun cli/src/index.ts workflow ./my-workflow.json --extension extensions/extensions/workflow-builder
 *   bun cli/src/index.ts extension create my-extension
 *   bun cli/src/index.ts extension package my-extension
 *   bun cli/src/index.ts extension upload my-extension --url http://localhost:3000 --space my-space --token abc123
 *   cd extensions/extensions/my-extension && bun ../../../cli/src/index.ts extension package
 */

import { parseArgs, runWorkflowLocally } from "./workflow.ts";
import { commandCreate, commandPackage, commandUpload } from "./extension.ts";
import {
  commandCat,
  commandWrite,
  commandCreate as commandDocCreate,
  commandLs,
  commandSearch,
} from "./document.ts";

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const value = args[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Flag --${key} requires a value`);
      flags[key] = value;
      i++;
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

function printUsage(): void {
  console.log(`
Usage:
  vektor workflow <workflow.json> --extension <path> [--extension <path>...] [--json] [--timeout-ms <ms>]
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

  if (command === "workflow") {
    const options = parseArgs(rest);
    const result = await runWorkflowLocally(options);

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }

    process.stdout.write(`Workflow: ${options.workflowPath}\n`);
    process.stdout.write(`Order: ${result.order.join(" -> ")}\n`);
    for (const nodeId of result.order) {
      const node = result.nodes[nodeId];
      process.stdout.write(`${nodeId}: ${node.status}\n`);
      if (node.outputs) process.stdout.write(`${JSON.stringify(node.outputs)}\n`);
    }
    process.stdout.write(`Output: ${JSON.stringify(result.output, null, 2)}\n`);
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

  throw new Error(`Unknown command: ${command}\n\nTry: workflow, extension, document`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
