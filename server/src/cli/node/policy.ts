import { isAbsolute, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Policy } from "./types.ts";

type PermissionRequest = {
  toolCall?: {
    title?: string;
    kind?: string;
    locations?: Array<{ path?: string }>;
    rawInput?: unknown;
  };
  options?: Array<{ optionId: string; kind: string }>;
};

/** Kinds that never change anything, so they pass without asking. */
const HARMLESS = new Set(["read", "search", "think"]);
const MUTATING = new Set(["edit", "delete", "move", "execute"]);

function within(workdir: string, path: string): boolean {
  const from = relative(resolve(workdir), resolve(workdir, path));
  return from === "" || (!from.startsWith("..") && !isAbsolute(from));
}

export function decide(
  policy: Policy,
  request: PermissionRequest,
): "allow" | "reject" | "ask" {
  const call = request.toolCall ?? {};
  const kind = call.kind ?? "other";
  const paths = (call.locations ?? []).flatMap((l) => (l.path ? [l.path] : []));
  if (paths.some((path) => !within(policy.workdir, path))) return "reject";
  if (policy.readonly && MUTATING.has(kind)) return "reject";
  if (policy.autoApprove || HARMLESS.has(kind)) return "allow";
  if (kind === "execute" && policy.allowShell) return "allow";
  return "ask";
}

/** The ACP response to a `session/request_permission` the agent made. */
export async function answerPermission(
  policy: Policy,
  params: unknown,
): Promise<{
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}> {
  const request = (params ?? {}) as PermissionRequest;
  let decision = decide(policy, request);
  if (decision === "ask") {
    const call = request.toolCall ?? {};
    const question = `Allow ${call.title ?? call.kind ?? "this action"}?`;
    decision = (await policy.confirm(question)) ? "allow" : "reject";
  }
  const wanted =
    decision === "allow"
      ? ["allow_once", "allow_always"]
      : ["reject_once", "reject_always"];
  const option = wanted
    .map((kind) => request.options?.find((o) => o.kind === kind))
    .find((o) => o !== undefined);
  return option
    ? { outcome: { outcome: "selected", optionId: option.optionId } }
    : { outcome: { outcome: "cancelled" } };
}

/** Asks on the node's terminal, one question at a time; refuses when nobody is there. */
export function terminalConfirm(): Policy["confirm"] {
  let queue: Promise<unknown> = Promise.resolve();
  return (question) => {
    if (!process.stdin.isTTY) return Promise.resolve(false);
    const answer = queue.then(
      () =>
        new Promise<boolean>((resolveAnswer) => {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          rl.question(`${question} [y/N] `, (text) => {
            rl.close();
            resolveAnswer(/^y(es)?$/i.test(text.trim()));
          });
        }),
    );
    queue = answer;
    return answer;
  };
}
