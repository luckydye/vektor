import { decodeBytesToUtf8, defineCommand } from "just-bash";
import { evalJsSync } from "@wiki/js-engine";

export const jsExecCommand = defineCommand("js-exec", async (args, ctx) => {
  const usage =
    "Usage: js-exec [OPTIONS] [-c CODE | FILE] [ARGS...]\n" +
    "\n" +
    "Options:\n" +
    "  -c, --code CODE    Execute CODE directly\n" +
    "  -m, --module       Treat as ES module\n" +
    "  --strip-types      Strip TypeScript types before execution\n" +
    "\n" +
    "Examples:\n" +
    '  js-exec -c "console.log(1 + 2)"\n' +
    "  js-exec script.js\n";

  let code: string | null = null;
  let scriptPath = "js-exec";
  let isModule = false;
  let stripTypes = false;
  let scriptArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-m" || arg === "--module") {
      isModule = true;
      continue;
    }
    if (arg === "--strip-types") {
      stripTypes = true;
      continue;
    }
    if (arg === "-c" || arg === "--code") {
      if (i + 1 >= args.length) {
        return {
          stdout: "",
          stderr: "js-exec: option requires an argument -- 'c'\n",
          exitCode: 2,
        };
      }
      code = args[++i]!;
      scriptPath = "-c";
      scriptArgs = args.slice(i + 1);
      break;
    }
    if (arg === "--version" || arg === "-V") {
      return { stdout: "Boa js-exec\n", stderr: "", exitCode: 0 };
    }
    if (arg === "--help" || arg === "-h") {
      return { stdout: usage, stderr: "", exitCode: 0 };
    }
    if (arg.startsWith("-") && arg !== "-" && arg !== "--") {
      return {
        stdout: "",
        stderr: `js-exec: unrecognized option '${arg}'\n`,
        exitCode: 2,
      };
    }
    if (arg === "--") {
      if (i + 1 < args.length) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, args[i + 1]!);
        if (!(await ctx.fs.exists(filePath))) {
          return {
            stdout: "",
            stderr: `js-exec: can't open file '${args[i + 1]}': No such file or directory\n`,
            exitCode: 2,
          };
        }
        code = await ctx.fs.readFile(filePath, "utf8");
        scriptPath = args[i + 1]!;
        scriptArgs = args.slice(i + 2);
      }
      break;
    }
    if (!arg.startsWith("-")) {
      const filePath = ctx.fs.resolvePath(ctx.cwd, arg);
      if (!(await ctx.fs.exists(filePath))) {
        return {
          stdout: "",
          stderr: `js-exec: can't open file '${arg}': No such file or directory\n`,
          exitCode: 2,
        };
      }
      code = await ctx.fs.readFile(filePath, "utf8");
      scriptPath = arg;
      scriptArgs = args.slice(i + 1);
      break;
    }
  }

  if (code === null) {
    const stdinText = decodeBytesToUtf8(ctx.stdin).trim();
    if (stdinText) {
      code = stdinText;
      scriptPath = "<stdin>";
    } else {
      return {
        stdout: "",
        stderr: "js-exec: no input provided (use -c CODE or provide a script file)\n",
        exitCode: 2,
      };
    }
  }

  // Auto-detect module mode and TypeScript
  if (
    scriptPath.endsWith(".mjs") ||
    scriptPath.endsWith(".mts") ||
    scriptPath.endsWith(".ts")
  ) {
    isModule = true;
  }
  if (scriptPath.endsWith(".ts") || scriptPath.endsWith(".mts")) {
    stripTypes = true;
  }
  if (!isModule && /\bawait\s+[\w([`]/.test(code)) {
    isModule = true;
  }

  // Strip TypeScript types if needed
  if (stripTypes) {
    try {
      const transpiler = new (
        Bun as unknown as {
          Transpiler: new (opts: {
            loader: string;
          }) => { transformSync: (code: string) => string };
        }
      ).Transpiler({ loader: "ts" });
      code = transpiler.transformSync(code);
    } catch (e) {
      return {
        stdout: "",
        stderr: `js-exec: TypeScript transpilation failed: ${e instanceof Error ? e.message : String(e)}\n`,
        exitCode: 1,
      };
    }
  }

  // Wrap in async IIFE for top-level await support
  const wrappedCode = isModule ? `(async () => { ${code} })()` : code;

  const envEntries = [...ctx.env.entries()].map(([k, v]) => [k, v]);

  const result = evalJsSync(
    wrappedCode,
    {
      argv: ["js-exec", scriptPath, ...scriptArgs],
      cwd: ctx.cwd,
      env: envEntries,
      platform: process.platform,
      version: process.version,
    },
    {
      timeoutMs: 10_000,
      filename: scriptPath,
    },
  );

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
});
