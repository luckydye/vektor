import { randomUUID } from "node:crypto";
import type {
  AgentNodeHost,
  NodeHelloFrame,
  NodeSummary,
  NodeToServerFrame,
  RemoteTaskPoll,
  RemoteTaskStatus,
  ServerToNodeFrame,
} from "./protocol.ts";

/**
 * The nodes connected to this server and the tasks running on them. A node
 * belongs to the user whose access token it dialled in with, within one space,
 * and only agents running as that user can reach it.
 */

/** How long a node may be away before the tasks it was running are failed. */
const RECONNECT_GRACE_MS = 30_000;
/** How long a finished task stays readable. */
const FINISHED_TASK_RETENTION_MS = 10 * 60_000;
const MAX_OUTPUT_CHARS = 200_000;
const MAX_MAILBOX = 100;

export interface NodeTransport {
  send(frame: ServerToNodeFrame): void;
  close(): void;
}

type Message = { from: string; text: string };

type RemoteTask = {
  id: string;
  spaceId: string;
  userId: string;
  nodeKey: string;
  status: RemoteTaskStatus;
  output: string;
  error?: string;
  /** For the remote agent: `read_messages` drains it. */
  inbox: Message[];
  /** From the remote agent to others in the turn; the hub drains it by polling. */
  outbox: Array<{ to: string; text: string }>;
  wake: Set<() => void>;
};

type ConnectedNode = {
  key: string;
  spaceId: string;
  userId: string;
  hello: NodeHelloFrame;
  transport: NodeTransport | null;
  graceTimer?: ReturnType<typeof setTimeout>;
};

const nodeKey = (spaceId: string, userId: string, name: string) =>
  `${spaceId}\0${userId}\0${name}`;

export class NodeRegistry implements AgentNodeHost {
  private nodes = new Map<string, ConnectedNode>();
  private tasks = new Map<string, RemoteTask>();

  /** Registers a node's connection; the returned handle takes its frames and its disconnect. */
  connect(
    scope: { spaceId: string; userId: string },
    hello: NodeHelloFrame,
    transport: NodeTransport,
  ) {
    const key = nodeKey(scope.spaceId, scope.userId, hello.name);
    const previous = this.nodes.get(key);
    if (previous) {
      clearTimeout(previous.graceTimer);
      // A node that dials in again replaces its stale connection.
      previous.transport?.close();
    }
    const node: ConnectedNode = { key, ...scope, hello, transport };
    this.nodes.set(key, node);

    // Tasks the node no longer runs died with its previous process.
    const alive = new Set(hello.sessions);
    for (const task of this.tasks.values()) {
      if (task.nodeKey === key && task.status === "running" && !alive.has(task.id)) {
        this.settle(task, "failed", `Node "${hello.name}" restarted and lost this task.`);
      }
    }

    return {
      handle: (frame: NodeToServerFrame) => this.handleFrame(node, frame),
      disconnect: () => this.disconnect(node, transport),
    };
  }

  private disconnect(node: ConnectedNode, transport: NodeTransport) {
    if (node.transport !== transport) return;
    node.transport = null;
    node.graceTimer = setTimeout(() => {
      if (this.nodes.get(node.key) === node) this.nodes.delete(node.key);
      for (const task of this.tasks.values()) {
        if (task.nodeKey === node.key && task.status === "running") {
          this.settle(task, "failed", `Node "${node.hello.name}" went offline.`);
        }
      }
    }, RECONNECT_GRACE_MS);
    node.graceTimer.unref?.();
  }

  private handleFrame(node: ConnectedNode, frame: NodeToServerFrame) {
    if (frame.type === "hello") {
      node.hello = { ...frame, name: node.hello.name };
      return;
    }
    if (frame.type === "ping") {
      node.transport?.send({ type: "ping" });
      return;
    }
    // Only a node's own tasks answer to it.
    const task = this.tasks.get(frame.taskId);
    if (!task || task.nodeKey !== node.key || task.status !== "running") return;

    if (frame.type === "session.update") {
      const update = frame.update;
      const content = update.content as { type?: string; text?: unknown } | undefined;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        content?.type === "text" &&
        typeof content.text === "string" &&
        task.output.length < MAX_OUTPUT_CHARS
      ) {
        task.output += content.text;
      }
    } else if (frame.type === "message") {
      if (task.outbox.length < MAX_MAILBOX) {
        task.outbox.push({ to: frame.to, text: frame.text });
        this.notify(task);
      }
    } else if (frame.type === "session.result") {
      if (frame.stopReason === "end_turn") this.settle(task, "done", task.output);
      else if (frame.stopReason === "cancelled")
        this.settle(task, "cancelled", "Cancelled.");
      else this.settle(task, "failed", frame.error ?? "The remote agent failed.");
    }
  }

  private settle(task: RemoteTask, status: RemoteTaskStatus, output: string) {
    if (task.status !== "running") return;
    task.status = status;
    if (status === "done") task.output = output;
    else task.error = output;
    this.notify(task);
    const timer = setTimeout(
      () => this.tasks.delete(task.id),
      FINISHED_TASK_RETENTION_MS,
    );
    timer.unref?.();
  }

  private notify(task: RemoteTask) {
    for (const wake of task.wake) wake();
  }

  private ownNodes(spaceId: string, userId: string) {
    return [...this.nodes.values()].filter(
      (n) => n.spaceId === spaceId && n.userId === userId,
    );
  }

  private runningOn(node: ConnectedNode) {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.nodeKey === node.key && task.status === "running") count++;
    }
    return count;
  }

  async listNodes({
    spaceId,
    userId,
  }: {
    spaceId: string;
    userId: string;
  }): Promise<NodeSummary[]> {
    return this.ownNodes(spaceId, userId).map((node) => ({
      name: node.hello.name,
      os: node.hello.os,
      workdir: node.hello.workdir,
      adapters: node.hello.adapters,
      maxSessions: node.hello.maxSessions,
      running: this.runningOn(node),
      online: node.transport !== null,
    }));
  }

  async startRemoteTask(request: Parameters<AgentNodeHost["startRemoteTask"]>[0]) {
    const { spaceId, userId, jobToken, task: prompt } = request;
    const candidates = this.ownNodes(spaceId, userId).filter((n) => n.transport);
    const node = request.node
      ? candidates.find((n) => n.hello.name === request.node)
      : candidates.find(
          (n) =>
            this.runningOn(n) < n.hello.maxSessions &&
            (!request.adapter || n.hello.adapters.includes(request.adapter)),
        );
    if (!node?.transport) {
      throw new Error(
        request.node
          ? `Node "${request.node}" is not online. Use list_nodes to see what is.`
          : "No node is online for this user. Start one with `vektor agent serve`.",
      );
    }
    const adapter = request.adapter ?? node.hello.adapters[0];
    if (!adapter || !node.hello.adapters.includes(adapter)) {
      throw new Error(
        `Node "${node.hello.name}" has no "${request.adapter}" adapter; it offers ${node.hello.adapters.join(", ") || "none"}.`,
      );
    }
    if (this.runningOn(node) >= node.hello.maxSessions) {
      throw new Error(
        `Node "${node.hello.name}" is running its maximum of ${node.hello.maxSessions} sessions.`,
      );
    }

    const taskId = `rt-${randomUUID()}`;
    this.tasks.set(taskId, {
      id: taskId,
      spaceId,
      userId,
      nodeKey: node.key,
      status: "running",
      output: "",
      inbox: [],
      outbox: [],
      wake: new Set(),
    });
    node.transport.send({
      type: "session.new",
      taskId,
      adapter,
      access: { spaceId, jobToken },
    });
    node.transport.send({ type: "session.prompt", taskId, text: prompt });
    return { taskId };
  }

  private task(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`No remote task "${taskId}".`);
    return task;
  }

  async pollRemoteTask(taskId: string, waitMs: number): Promise<RemoteTaskPoll> {
    const task = this.task(taskId);
    if (task.status === "running" && !task.outbox.length && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          task.wake.delete(done);
          resolve();
        };
        const timer = setTimeout(done, waitMs);
        task.wake.add(done);
      });
    }
    return {
      status: task.status,
      ...(task.status === "running"
        ? {}
        : { output: task.status === "done" ? task.output : (task.error ?? "") }),
      messages: task.outbox.splice(0),
    };
  }

  async sendRemoteTask(taskId: string, from: string, text: string) {
    const task = this.task(taskId);
    if (task.status !== "running")
      throw new Error("The remote task is no longer running.");
    if (task.inbox.length >= MAX_MAILBOX) task.inbox.shift();
    task.inbox.push({ from, text });
  }

  async cancelRemoteTask(taskId: string) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== "running") return;
    this.nodes.get(task.nodeKey)?.transport?.send({ type: "session.cancel", taskId });
    this.settle(task, "cancelled", "Cancelled.");
  }

  /**
   * What the remote agent's MCP tools reach. Scoped to the task's own user and
   * space, so a job token for another task cannot read or write this one.
   */
  forAgent(taskId: string, scope: { spaceId: string; userId: string | null }) {
    const task = this.tasks.get(taskId);
    if (!task || task.spaceId !== scope.spaceId || task.userId !== scope.userId) {
      throw new Error(`No remote task "${taskId}".`);
    }
    return {
      readMessages: () => task.inbox.splice(0),
      sendMessage: (to: string, text: string) => {
        if (task.status !== "running") throw new Error("This task is no longer running.");
        if (task.outbox.length >= MAX_MAILBOX)
          throw new Error("Too many unread messages.");
        task.outbox.push({ to, text });
        this.notify(task);
      },
    };
  }
}

/** The one registry of this server process. */
export const nodeRegistry = new NodeRegistry();
