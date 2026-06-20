import { defineCommand } from "just-bash";

/**
 * Stubs for runtimes the model reaches for out of habit (node, python, …)
 * that are NOT installed in the sandbox. Instead of a cryptic
 * "command not found", they redirect to the one available scripting runtime,
 * `js-exec` (the native JavaScript sandbox), so the agent recovers in a single step.
 */
function unavailableRuntime(name: string, hint: string) {
  return defineCommand(name, async () => ({
    stdout: "",
    stderr: `${name} is not installed in this sandbox. ${hint}\n`,
    exitCode: 127,
  }));
}

const JS_HINT =
  'Run JavaScript/TypeScript with `js-exec` instead: `js-exec -c "<code>"` or `js-exec script.js` (QuickJS; no require/fetch/node built-ins).';
const PY_HINT =
  "Python is unavailable. For scripting use `js-exec` (JavaScript/TypeScript in a QuickJS sandbox), or a shell pipeline.";

export const runtimeStubCommands = [
  unavailableRuntime("node", JS_HINT),
  unavailableRuntime("nodejs", JS_HINT),
  unavailableRuntime("npm", JS_HINT),
  unavailableRuntime("npx", JS_HINT),
  unavailableRuntime("bun", JS_HINT),
  unavailableRuntime("deno", JS_HINT),
  unavailableRuntime("ts-node", JS_HINT),
  unavailableRuntime("python", PY_HINT),
  unavailableRuntime("python3", PY_HINT),
];
