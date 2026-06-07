import { posix } from "node:path";
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
  const allowed = new Set(names.map((name) => name.toLowerCase()));
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

function convertHtmlTableToCsv(html: string): string {
  const ast = html5parser.parse(html);
  const table = findFirstTag(ast, "table");
  if (!table) {
    throw new Error("No <table> found in HTML input");
  }

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

export {
  collectChildTags,
  convertHtmlTableToCsv,
  escapeCsvCell,
  findFirstTag,
  getNodeText,
  isTag,
  normalizeHtmlText,
};

export const pandocCommand = defineCommand("pandoc", async (args, ctx) => {
  const usage =
    "usage: pandoc -f <html|html-table> -t csv [input-file] [-o output-file]\n" +
    "examples:\n" +
    "  pandoc -f html -t csv table.html > table.csv\n" +
    "  pandoc -f html-table -t csv table.html > table.csv\n";

  let from: string | null = null;
  let to: string | null = null;
  let outputFile: string | null = null;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-f" || arg === "--from") {
      from = args[++index] ?? null;
      continue;
    }
    if (arg === "-t" || arg === "--to") {
      to = args[++index] ?? null;
      continue;
    }
    if (arg === "-o" || arg === "--output") {
      outputFile = args[++index] ?? null;
      continue;
    }
    positional.push(arg);
  }

  if (!to) {
    return { stdout: "", stderr: `${usage}`, exitCode: 2 };
  }
  if (!from && positional[0]) {
    const ext = posix.extname(positional[0]).slice(1).toLowerCase();
    from = ext || null;
  }
  from ??= "html";

  const inputPath = positional[0] ? ctx.fs.resolvePath(ctx.cwd, positional[0]) : null;
  const inputBytes = inputPath
    ? await ctx.fs.readFileBuffer(inputPath)
    : new TextEncoder().encode(ctx.stdin);

  if ((from === "html-table" || from === "html") && to === "csv") {
    const csv = convertHtmlTableToCsv(Buffer.from(inputBytes).toString("utf-8"));
    if (outputFile) {
      const outputPath = ctx.fs.resolvePath(ctx.cwd, outputFile);
      await ctx.fs.writeFile(outputPath, csv, "utf8");
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: `${csv}\n`, stderr: "", exitCode: 0 };
  }

  throw new Error(`Unsupported conversion: ${from} -> ${to}`);
});
