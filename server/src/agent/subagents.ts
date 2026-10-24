/**
 * Sub-agents of one agent turn: background runs the agent starts, polls,
 * waits for and cancels through tools. They live only as long as the turn;
 * `cancelAll` stops whatever is still running when it ends.
 *
 * The parent and its sub-agents also message each other with `send_message`.
 * A message reaches its recipient before the recipient's next model call, or
 * ends the parent's `wait_subagents` early.
 */

const PARENT = "parent";

/** One agent's side of the turn: the tools it is given and its inbox. */
export type AgentLink = {
  tools: object[];
  handles: (name: string) => boolean;
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  /** Takes the messages sent to this agent since the last call, formatted for the model. */
  drain: () => string | undefined;
};

const MAX_RUNNING = 5;
const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 600;

type SubagentState = {
  id: string;
  task: string;
  status: "running" | "done" | "failed" | "cancelled";
  output?: string;
  controller: AbortController;
  settled: Promise<void>;
};

function tool(name: string, description: string, properties: object, required: string[] = []) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  };
}

const sendMessageTool = tool(
  "send_message",
  `Send a message to another agent in this turn: "${PARENT}" or a sub-agent id. ` +
    "It arrives before the recipient's next step; the recipient may be busy, so do not expect an instant reply.",
  { to: { type: "string" }, message: { type: "string" } },
  ["to", "message"],
);

const managerTools = [
  tool(
    "start_subagent",
    "Start a sub-agent on a self-contained task and return its id at once; it works in the background. " +
      "It has the same tools but a fresh context and none of this conversation, so the task must carry everything it needs. " +
      `Start several to work in parallel (at most ${MAX_RUNNING} running at a time), then collect them with wait_subagents. ` +
      "Sub-agents cannot start sub-agents.",
    { task: { type: "string", description: "Complete instructions for the sub-agent." } },
    ["task"],
  ),
  tool("list_subagents", "List the sub-agents started this turn with their status.", {}),
  tool(
    "wait_subagents",
    "Wait until the given sub-agents (default: all running ones) finish, one of them messages you, or the timeout passes. " +
      "Returns each one's status and, once finished, its final answer or error, plus any messages sent to you.",
    {
      ids: { type: "array", items: { type: "string" } },
      timeout_seconds: {
        type: "number",
        description: `Default ${DEFAULT_WAIT_SECONDS}, at most ${MAX_WAIT_SECONDS}.`,
      },
    },
  ),
  tool(
    "cancel_subagent",
    "Stop a running sub-agent.",
    { id: { type: "string" } },
    ["id"],
  ),
];

export function createSubagentHub(
  run: (task: string, signal: AbortSignal, link: AgentLink) => Promise<string>,
) {
  const subagents = new Map<string, SubagentState>();
  const inboxes = new Map<string, Array<{ from: string; text: string }>>([[PARENT, []]]);
  let wakeParent: (() => void) | undefined;
  const running = () => [...subagents.values()].filter((s) => s.status === "running");

  const report = (state: SubagentState) => ({
    id: state.id,
    task: state.task,
    status: state.status,
    ...(state.output === undefined
      ? {}
      : { [state.status === "done" ? "result" : "error"]: state.output }),
  });

  const find = (id: unknown) => {
    const state = typeof id === "string" ? subagents.get(id) : undefined;
    if (!state) throw new Error(`No sub-agent with id "${String(id)}".`);
    return state;
  };

  function drainMessages(id: string) {
    const inbox = inboxes.get(id) ?? [];
    return inbox.splice(0).map((m) => `[from ${m.from}] ${m.text}`);
  }

  function send(from: string, to: unknown, message: unknown) {
    if (typeof message !== "string" || !message.trim()) {
      throw new Error('send_message requires a non-empty "message".');
    }
    if (typeof to !== "string" || to === from) {
      throw new Error(`"to" must be "${PARENT}" or a sub-agent id other than your own.`);
    }
    if (to !== PARENT && find(to).status !== "running") {
      throw new Error(`Sub-agent "${to}" is no longer running.`);
    }
    inboxes.get(to)?.push({ from, text: message });
    if (to === PARENT) wakeParent?.();
    return `Sent to ${to}.`;
  }

  function linkFor(
    id: string,
    extra: Record<string, (args: Record<string, unknown>) => unknown>,
    extraTools: object[],
  ): AgentLink {
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      ...extra,
      send_message: (args) => send(id, args.to, args.message),
    };
    return {
      tools: [...extraTools, sendMessageTool],
      handles: (name) => Object.hasOwn(handlers, name),
      call: async (name, args) => handlers[name]?.(args),
      drain: () => {
        const messages = drainMessages(id);
        return messages.length
          ? `Messages from other agents:\n${messages.join("\n")}`
          : undefined;
      },
    };
  }

  function start(task: unknown) {
    if (typeof task !== "string" || !task.trim()) {
      throw new Error('start_subagent requires a non-empty "task".');
    }
    if (running().length >= MAX_RUNNING) {
      throw new Error(
        `${MAX_RUNNING} sub-agents are already running; wait for or cancel one first.`,
      );
    }
    const controller = new AbortController();
    const state: SubagentState = {
      id: `sub-${subagents.size + 1}`,
      task,
      status: "running",
      controller,
      settled: Promise.resolve(),
    };
    inboxes.set(state.id, []);
    subagents.set(state.id, state);
    const finish = (status: "done" | "failed", output: string) => {
      if (state.status !== "running") return;
      state.status = status;
      state.output = output;
      wakeParent?.();
    };
    state.settled = run(task, controller.signal, linkFor(state.id, {}, [])).then(
      (output) => finish("done", output || "(no output)"),
      (error) => finish("failed", error instanceof Error ? error.message : String(error)),
    );
    return { id: state.id, status: state.status };
  }

  async function wait(ids: unknown, timeoutSeconds: unknown) {
    const targets = Array.isArray(ids) ? ids.map(find) : running();
    const seconds = Math.min(
      typeof timeoutSeconds === "number" && timeoutSeconds > 0
        ? timeoutSeconds
        : DEFAULT_WAIT_SECONDS,
      MAX_WAIT_SECONDS,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (!inboxes.get(PARENT)?.length) {
      await Promise.race([
        Promise.all(targets.map((s) => s.settled)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, seconds * 1000);
        }),
        new Promise<void>((resolve) => {
          wakeParent = resolve;
        }),
      ]);
    }
    clearTimeout(timer);
    wakeParent = undefined;
    return { agents: targets.map(report), messages: drainMessages(PARENT) };
  }

  function cancel(id: unknown) {
    const state = find(id);
    if (state.status === "running") {
      state.status = "cancelled";
      state.output = "Cancelled.";
      state.controller.abort();
    }
    return report(state);
  }

  return {
    parent: linkFor(
      PARENT,
      {
        start_subagent: (args) => start(args.task),
        list_subagents: () => [...subagents.values()].map(report),
        wait_subagents: (args) => wait(args.ids, args.timeout_seconds),
        cancel_subagent: (args) => cancel(args.id),
      },
      managerTools,
    ),
    cancelAll() {
      for (const state of running()) cancel(state.id);
    },
  };
}
