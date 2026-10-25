import type { AgentLink, SubagentTarget } from "#agent/subagents.ts";
import type { AgentNodeHost } from "./protocol.ts";

/** How long one poll may wait; also how late a message for the remote agent can be forwarded. */
const POLL_MS = 2_000;

/**
 * Runs a sub-agent's task on a node and returns its final answer. Messages
 * between the remote agent and the rest of the turn are carried across here:
 * what the remote agent sends goes through the hub's own `send_message`, and
 * what the hub holds for it is put in the task's mailbox for `read_messages`.
 */
export async function runRemoteSubagent(options: {
  nodes: AgentNodeHost;
  spaceId: string;
  userId: string;
  jobToken: string;
  task: string;
  target: SubagentTarget;
  signal: AbortSignal;
  link: AgentLink;
  /** Called once the remote agent's environment has a screen the user can open. */
  onScreen?: (screen: { taskId: string; node: string }) => void;
}): Promise<string> {
  const { nodes, signal, link } = options;
  const { taskId, node } = await nodes.startRemoteTask({
    spaceId: options.spaceId,
    userId: options.userId,
    jobToken: options.jobToken,
    task: options.task,
    node: options.target.node,
    adapter: options.target.agent,
  });
  const cancel = () => void nodes.cancelRemoteTask(taskId).catch(() => {});
  if (signal.aborted) cancel();
  signal.addEventListener("abort", cancel, { once: true });

  let screen = false;
  try {
    while (!signal.aborted) {
      const incoming = link.drain();
      if (incoming)
        await nodes.sendRemoteTask(taskId, "vektor", incoming).catch(() => {});
      const poll = await nodes.pollRemoteTask(taskId, POLL_MS);
      if (poll.screen && !screen) {
        screen = true;
        options.onScreen?.({ taskId, node });
      }
      for (const message of poll.messages) {
        // A recipient that has finished cannot be told; the remote agent is not blocked on it.
        await link
          .call("send_message", { to: message.to, message: message.text })
          .catch(() => {});
      }
      if (poll.status === "done") return poll.output ?? "";
      if (poll.status !== "running") throw new Error(poll.output || "Cancelled.");
    }
    throw new Error("Cancelled.");
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
