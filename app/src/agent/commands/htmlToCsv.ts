import * as html5parser from "html5parser";
import { defineCommand } from "just-bash";

type HtmlTagNode = html5parser.ITag;
type HtmlNode = html5parser.INode;

function isTag(node: HtmlNode, name?: string): node is HtmlTagNode {
  return (
    node.type === html5parser.SyntaxKind.Tag &&
    (name ? node.name.toLowerCase() === name : true)
  );
}

function getNodeText(node: HtmlNode): string {
  if (node.type === html5parser.SyntaxKind.Text) {
    return node.value;
  }
  if (!isTag(node) || !node.body) {
    return "";
  }
  return node.body.map(getNodeText).join("");
}

function normalizeHtmlText(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function findFirstTag(nodes: HtmlNode[], name: string): HtmlTagNode | null {
  for (const node of nodes) {
    if (isTag(node, name)) {
      return node;
    }
    if (isTag(node) && node.body) {
      const nested = findFirstTag(node.body, name);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

function collectChildTags(node: HtmlTagNode, names: string[]): HtmlTagNode[] {
  const result: HtmlTagNode[] = [];
  const allowed = new Set(names.map((n) => n.toLowerCase()));
  for (const child of node.body ?? []) {
    if (isTag(child) && allowed.has(child.name.toLowerCase())) {
      result.push(child);
    }
  }
  return result;
}

function escapeCsvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function tableNodeToCsv(table: HtmlTagNode): string {
  const rows = (table.body ?? []).flatMap((child) => {
    if (isTag(child, "thead") || isTag(child, "tbody") || isTag(child, "tfoot")) {
      return collectChildTags(child, ["tr"]);
    }
    return isTag(child, "tr") ? [child] : [];
  });

  if (rows.length === 0) {
    throw new Error("HTML table contains no rows");
  }

  return rows
    .map((row) =>
      collectChildTags(row, ["th", "td"])
        .map((cell) => escapeCsvCell(normalizeHtmlText(getNodeText(cell))))
        .join(","),
    )
    .join("\n");
}

async function readInput(
  args: string[],
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1],
): Promise<{ html: string; outputFile: string | null }> {
  let outputFile: string | null = null;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-o" || args[i] === "--output") {
      outputFile = args[++i] ?? null;
    } else {
      positional.push(args[i]!);
    }
  }

  const inputPath = positional[0] ? ctx.fs.resolvePath(ctx.cwd, positional[0]) : null;
  const bytes = inputPath
    ? await ctx.fs.readFileBuffer(inputPath)
    : new TextEncoder().encode(ctx.stdin);

  return { html: Buffer.from(bytes).toString("utf-8"), outputFile };
}

async function writeOutput(
  csv: string,
  outputFile: string | null,
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  if (outputFile) {
    await ctx.fs.writeFile(ctx.fs.resolvePath(ctx.cwd, outputFile), csv, "utf8");
    return { stdout: "", stderr: "", exitCode: 0 };
  }
  return { stdout: `${csv}\n`, stderr: "", exitCode: 0 };
}

/**
 * html-to-csv [input-file] [-o output-file]
 * Extracts the first <table> from an HTML document and converts it to CSV.
 */
export const htmlToCsvCommand = defineCommand("html-to-csv", async (args, ctx) => {
  const { html, outputFile } = await readInput(args, ctx);
  const ast = html5parser.parse(html);
  const table = findFirstTag(ast, "table");
  if (!table) {
    return {
      stdout: "",
      stderr: "html-to-csv: no <table> found in input\n",
      exitCode: 1,
    };
  }
  return writeOutput(tableNodeToCsv(table), outputFile, ctx);
});

/**
 * html-table-to-csv [input-file] [-o output-file]
 * Converts an HTML fragment that is itself a <table> to CSV.
 */
export const htmlTableToCsvCommand = defineCommand(
  "html-table-to-csv",
  async (args, ctx) => {
    const { html, outputFile } = await readInput(args, ctx);
    const ast = html5parser.parse(html);
    const table = findFirstTag(ast, "table");
    if (!table) {
      return {
        stdout: "",
        stderr: "html-table-to-csv: no <table> found in input\n",
        exitCode: 1,
      };
    }
    return writeOutput(tableNodeToCsv(table), outputFile, ctx);
  },
);
