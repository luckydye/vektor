import { htmlTableToCsv } from "@vektorapp/spreadsheet/table";
import { decodeBytesToUtf8, defineCommand } from "just-bash";

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
  const html = inputPath
    ? Buffer.from(await ctx.fs.readFileBuffer(inputPath)).toString("utf-8")
    : decodeBytesToUtf8(ctx.stdin);

  return { html, outputFile };
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

async function runHtmlToCsv(
  name: string,
  args: string[],
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1],
) {
  const { html, outputFile } = await readInput(args, ctx);
  const csv = htmlTableToCsv(html, { collapseWhitespace: true });
  if (csv === null) {
    return { stdout: "", stderr: `${name}: no <table> found in input\n`, exitCode: 1 };
  }
  return writeOutput(csv, outputFile, ctx);
}

/**
 * html-to-csv [input-file] [-o output-file]
 * Extracts the first <table> from an HTML document and converts it to CSV.
 */
export const htmlToCsvCommand = defineCommand("html-to-csv", (args, ctx) =>
  runHtmlToCsv("html-to-csv", args, ctx),
);

/**
 * html-table-to-csv [input-file] [-o output-file]
 * Converts an HTML fragment that is itself a <table> to CSV.
 */
export const htmlTableToCsvCommand = defineCommand("html-table-to-csv", (args, ctx) =>
  runHtmlToCsv("html-table-to-csv", args, ctx),
);
