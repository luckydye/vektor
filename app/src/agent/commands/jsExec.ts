import RELEASE_SYNC from "@jitl/quickjs-wasmfile-release-sync";
// @ts-expect-error -- Bun bundles .wasm imports as assets in --compile binaries
import wasmPath from "@jitl/quickjs-wasmfile-release-sync/wasm";
import { decodeBytesToUtf8, defineCommand } from "just-bash";
import { newQuickJSWASMModuleFromVariant, newVariant } from "quickjs-emscripten";

let quickJSModulePromise: ReturnType<typeof newQuickJSWASMModuleFromVariant> | null =
  null;
function getQuickJSModule() {
  if (!quickJSModulePromise) {
    const variant = newVariant(RELEASE_SYNC, { wasmLocation: wasmPath });
    quickJSModulePromise = newQuickJSWASMModuleFromVariant(variant);
  }
  return quickJSModulePromise;
}

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
      return { stdout: "QuickJS js-exec\n", stderr: "", exitCode: 0 };
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

  let stdout = "";
  let stderr = "";

  try {
    const module = await getQuickJSModule();
    const context = module.newContext();

    // Interrupt handler for 10s timeout
    const deadline = Date.now() + 10000;
    context.runtime.setInterruptHandler(() => (Date.now() > deadline ? 1 : 0));

    // Helper to create a console method
    const makeConsoleMethod = (sink: "stdout" | "stderr") => {
      return context.newFunction(
        `console.${sink === "stdout" ? "log" : "error"}`,
        (...handles) => {
          for (const h of handles) {
            if (sink === "stdout") stdout += context.getString(h);
            else stderr += context.getString(h);
          }
          if (sink === "stdout") stdout += "\n";
          else stderr += "\n";
          return context.undefined;
        },
      );
    };

    const consoleObj = context.newObject();
    const consoleLog = makeConsoleMethod("stdout");
    const consoleError = makeConsoleMethod("stderr");
    const consoleWarn = makeConsoleMethod("stderr");
    const consoleInfo = makeConsoleMethod("stdout");
    const consoleDebug = makeConsoleMethod("stdout");
    context.setProp(consoleObj, "log", consoleLog);
    context.setProp(consoleObj, "error", consoleError);
    context.setProp(consoleObj, "warn", consoleWarn);
    context.setProp(consoleObj, "info", consoleInfo);
    context.setProp(consoleObj, "debug", consoleDebug);
    context.setProp(context.global, "console", consoleObj);

    // process
    const processObj = context.newObject();
    const processArgv = context.newArray();
    let idx = 0;
    for (const arg of ["js-exec", scriptPath, ...scriptArgs]) {
      const handle = context.newString(arg);
      context.setProp(processArgv, idx++, handle);
      handle.dispose();
    }
    context.setProp(processObj, "argv", processArgv);
    const processCwd = context.newFunction("process.cwd", () =>
      context.newString(ctx.cwd),
    );
    context.setProp(processObj, "cwd", processCwd);
    const processEnv = context.newObject();
    for (const [key, value] of ctx.env) {
      const vh = context.newString(value);
      context.setProp(processEnv, key, vh);
      vh.dispose();
    }
    context.setProp(processObj, "env", processEnv);
    const processPlatform = context.newString(process.platform);
    context.setProp(processObj, "platform", processPlatform);
    const processVersion = context.newString(process.version);
    context.setProp(processObj, "version", processVersion);
    context.setProp(context.global, "process", processObj);

    // Wrap code in async IIFE for top-level await support
    const wrappedCode = isModule ? `(async () => { ${code} })()` : code;

    const result = context.evalCode(wrappedCode, scriptPath);

    let exitCode = 0;
    if (result.error) {
      const errorNameHandle = context.getProp(result.error, "name");
      const errorMessageHandle = context.getProp(result.error, "message");
      const errorName = context.getString(errorNameHandle);
      const errorMessage = context.getString(errorMessageHandle);
      errorNameHandle.dispose();
      errorMessageHandle.dispose();
      stderr += `js-exec: ${errorName}: ${errorMessage}\n`;
      exitCode = 1;
      result.error.dispose();
    } else {
      result.value.dispose();
    }

    // Clean up handles
    consoleLog.dispose();
    consoleError.dispose();
    consoleWarn.dispose();
    consoleInfo.dispose();
    consoleDebug.dispose();
    consoleObj.dispose();
    processArgv.dispose();
    processCwd.dispose();
    processEnv.dispose();
    processPlatform.dispose();
    processVersion.dispose();
    processObj.dispose();
    context.dispose();

    return { stdout, stderr, exitCode };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { stdout, stderr: `js-exec: ${message}\n`, exitCode: 1 };
  }
});
