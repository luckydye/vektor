import { defineCommand } from "just-bash";

/**
 * Stubs for runtimes the model reaches for out of habit (node, python, …)
 * that are NOT installed in the sandbox. Instead of a cryptic
 * "command not found", they redirect to shell pipelines and workflows, so the
 * agent recovers in a single step.
 */
function unavailableRuntime(name: string, hint: string) {
  return defineCommand(name, async () => ({
    stdout: "",
    stderr: `${name} is not installed in this sandbox. ${hint}\n`,
    exitCode: 127,
  }));
}

const HINT =
  "Shape text and JSON with jq, awk or sed; run JavaScript as a workflow (see the `workflow` recipe).";

export const runtimeStubCommands = [
  unavailableRuntime("node", HINT),
  unavailableRuntime("nodejs", HINT),
  unavailableRuntime("npm", HINT),
  unavailableRuntime("npx", HINT),
  unavailableRuntime("bun", HINT),
  unavailableRuntime("deno", HINT),
  unavailableRuntime("ts-node", HINT),
  unavailableRuntime("python", HINT),
  unavailableRuntime("python3", HINT),
];
