import type { AgentLink, SubagentTarget } from "#agent/subagents.ts";
import type { AgentRunnerHost } from "./agents.ts";

/** How long one poll may wait; also how late a message for the remote agent can be forwarded. */
const POLL_MS = 2_000;

/**
 * Runs a sub-agent's task on a node or runner and returns its final answer. Messages
 * between the remote agent and the rest of the turn are carried across here:
 * what the remote agent sends goes through the hub's own `send_message`, and
 * what the hub holds for it is put in the session's mailbox for `read_messages`.
 */
export async function runSubagentOnRunner(options: {
  runners: AgentRunnerHost;
  spaceId: string;
  userId: string;
  jobToken: string;
  task: string;
  target: SubagentTarget;
  signal: AbortSignal;
  link: AgentLink;
  /** Called once the remote agent's environment has a screen the user can open. */
  onScreen?: (screen: { sessionId: string; runner: string }) => void;
}): Promise<string> {
  const { runners, signal, link } = options;
  const { sessionId, runner } = await runners.startSession({
    spaceId: options.spaceId,
    userId: options.userId,
    jobToken: options.jobToken,
    task: options.task,
    runner: options.target.node,
    agent: options.target.agent,
  });
  const cancel = () => void runners.cancelSession(sessionId).catch(() => {});
  if (signal.aborted) cancel();
  signal.addEventListener("abort", cancel, { once: true });

  let screen = false;
  try {
    while (!signal.aborted) {
      const incoming = link.drain();
      if (incoming)
        await runners.sendToSession(sessionId, "vektor", incoming).catch(() => {});
      const poll = await runners.pollSession(sessionId, POLL_MS);
      if (poll.screen && !screen) {
        screen = true;
        options.onScreen?.({ sessionId, runner });
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
