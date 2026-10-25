import { randomUUID } from "node:crypto";
import {
  type AgentNodeHost,
  decodeScreenMedia,
  type NodeHelloFrame,
  type NodeSummary,
  type NodeToServerFrame,
  type PromptResult,
  type RemoteTaskPoll,
  type RemoteTaskStatus,
  type ScreenInputEvent,
  type ServerToNodeFrame,
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
/** How long a chat's session may sit between prompts before it is closed. */
const CHAT_IDLE_MS = 30 * 60_000;

export interface NodeTransport {
  send(frame: ServerToNodeFrame): void;
  close(): void;
}

type Message = { from: string; text: string };

/** Where a screen's media goes: the browser watching it. */
export interface ScreenViewer {
  send(bytes: Uint8Array): void;
  close(error?: string): void;
}

type OpenScreen = { taskId: string; nodeKey: string; viewer: ScreenViewer };

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
  screen: boolean;
  /** The chat whose session this is, kept open between prompts; null for a sub-agent's one-answer task. */
  chat: string | null;
  /** A chat's prompt in flight. */
  turn?: ChatTurn;
  idleTimer?: ReturnType<typeof setTimeout>;
};

type ChatTurn = {
  onUpdate(update: Record<string, unknown>): void;
  onScreen(taskId: string): void;
  done(result: PromptResult): void;
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

const isOpen = (task: RemoteTask) => task.status === "running" || task.status === "idle";

export class NodeRegistry implements AgentNodeHost {
  private nodes = new Map<string, ConnectedNode>();
  private tasks = new Map<string, RemoteTask>();
  private screens = new Map<string, OpenScreen>();
  /** A chat's session, by `nodeKey`-style chat key. */
  private chats = new Map<string, string>();

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
      if (task.nodeKey === key && isOpen(task) && !alive.has(task.id)) {
        this.settle(task, "failed", `Node "${hello.name}" restarted and lost this task.`);
      }
    }

    return {
      handle: (frame: NodeToServerFrame) => this.handleFrame(node, frame),
      media: (message: Uint8Array) => this.media(node, message),
      disconnect: () => this.disconnect(node, transport),
    };
  }

  private disconnect(node: ConnectedNode, transport: NodeTransport) {
    if (node.transport !== transport) return;
    node.transport = null;
    for (const [screenId, screen] of this.screens) {
      if (screen.nodeKey === node.key) this.endScreen(screenId, "The node went away.");
    }
    node.graceTimer = setTimeout(() => {
      if (this.nodes.get(node.key) === node) this.nodes.delete(node.key);
      for (const task of this.tasks.values()) {
        if (task.nodeKey === node.key && isOpen(task)) {
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
    if (frame.type === "screen.end") {
      if (this.screens.get(frame.screenId)?.nodeKey === node.key) {
        this.endScreen(frame.screenId, frame.error);
      }
      return;
    }
    // Only a node's own tasks answer to it.
    const task = this.tasks.get(frame.taskId);
    if (!task || task.nodeKey !== node.key || !isOpen(task)) return;

    if (frame.type === "session.update") {
      const update = frame.update;
      if (task.turn) {
        task.turn.onUpdate(update);
        return;
      }
      const content = update.content as { type?: string; text?: unknown } | undefined;
      if (
        update.sessionUpdate === "agent_message_chunk" &&
        content?.type === "text" &&
        typeof content.text === "string" &&
        task.output.length < MAX_OUTPUT_CHARS
      ) {
        task.output += content.text;
      }
    } else if (frame.type === "session.screen") {
      task.screen = true;
      task.turn?.onScreen(task.id);
      this.notify(task);
    } else if (frame.type === "message") {
      if (task.outbox.length < MAX_MAILBOX) {
        task.outbox.push({ to: frame.to, text: frame.text });
        this.notify(task);
      }
    } else if (frame.type === "session.result") {
      if (task.chat) this.endTurn(task, frame);
      else if (frame.stopReason === "end_turn") this.settle(task, "done", task.output);
      else if (frame.stopReason === "cancelled")
        this.settle(task, "cancelled", "Cancelled.");
      else this.settle(task, "failed", frame.error ?? "The remote agent failed.");
    }
  }

  /** A chat's prompt ended; its session waits for the next unless the agent failed. */
  private endTurn(task: RemoteTask, result: PromptResult) {
    if (result.stopReason === "error") {
      this.settle(task, "failed", result.error ?? "The remote agent failed.");
      return;
    }
    const turn = task.turn;
    task.turn = undefined;
    task.status = "idle";
    task.idleTimer = setTimeout(
      () => this.settle(task, "cancelled", "Closed after being idle."),
      CHAT_IDLE_MS,
    );
    task.idleTimer.unref?.();
    turn?.done(result);
  }

  private settle(task: RemoteTask, status: RemoteTaskStatus, output: string) {
    if (!isOpen(task)) return;
    task.status = status;
    if (status === "done") task.output = output;
    else task.error = output;
    clearTimeout(task.idleTimer);
    if (task.chat && this.chats.get(task.chat) === task.id) this.chats.delete(task.chat);
    this.nodes
      .get(task.nodeKey)
      ?.transport?.send({ type: "session.close", taskId: task.id });
    const turn = task.turn;
    task.turn = undefined;
    turn?.done({
      stopReason: status === "cancelled" ? "cancelled" : "error",
      error: output,
    });
    this.notify(task);
    for (const [screenId, screen] of this.screens) {
      if (screen.taskId === task.id) this.closeScreen(screenId);
    }
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

  /** Sessions open on `node`, idle chats' included: each holds an agent there. */
  private runningOn(node: ConnectedNode) {
    let count = 0;
    for (const task of this.tasks.values()) {
      if (task.nodeKey === node.key && isOpen(task)) count++;
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
    const { task, node } = this.open(request, null);
    task.status = "running";
    node.transport?.send({ type: "session.prompt", taskId: task.id, text: request.task });
    return { taskId: task.id, node: node.hello.name };
  }

  /** Starts a session on one of the user's online nodes; it is idle until prompted. */
  private open(
    request: {
      spaceId: string;
      userId: string;
      jobToken: string;
      node?: string;
      adapter?: string;
    },
    chat: string | null,
  ) {
    const { spaceId, userId, jobToken } = request;
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

    const task: RemoteTask = {
      id: `rt-${randomUUID()}`,
      spaceId,
      userId,
      nodeKey: node.key,
      status: "idle",
      output: "",
      inbox: [],
      outbox: [],
      wake: new Set(),
      screen: false,
      chat,
    };
    this.tasks.set(task.id, task);
    if (chat) this.chats.set(chat, task.id);
    node.transport.send({
      type: "session.new",
      taskId: task.id,
      adapter,
      access: { spaceId, jobToken },
    });
    return { task, node };
  }

  /**
   * Starts one prompt of a chat on its session at `node`, opening one when the
   * chat has none: on its first prompt, or after the session ended. `fresh`
   * says a session was opened, so it remembers no earlier prompt.
   */
  promptChat(
    request: {
      spaceId: string;
      userId: string;
      chatId: string;
      node: string;
      jobToken: string;
      text: string;
    } & Omit<ChatTurn, "done">,
  ): { fresh: boolean; result: Promise<PromptResult> } {
    const existing = this.chatTask(request);
    const fresh = !existing;
    const task =
      existing ??
      this.open(request, nodeKey(request.spaceId, request.userId, request.chatId)).task;
    if (task.status !== "idle")
      throw new Error("A prompt is already running in this chat.");
    const transport = this.nodes.get(task.nodeKey)?.transport;
    if (!transport) throw new Error(`Node "${request.node}" is offline.`);
    clearTimeout(task.idleTimer);
    task.status = "running";
    const result = new Promise<PromptResult>((done) => {
      task.turn = { onUpdate: request.onUpdate, onScreen: request.onScreen, done };
    });
    if (task.screen) request.onScreen(task.id);
    transport.send({ type: "session.prompt", taskId: task.id, text: request.text });
    return { fresh, result };
  }

  private chatTask(scope: { spaceId: string; userId: string; chatId: string }) {
    return this.tasks.get(
      this.chats.get(nodeKey(scope.spaceId, scope.userId, scope.chatId)) ?? "",
    );
  }

  /** Stops a chat's prompt in flight; its session stays open. */
  cancelChat(scope: { spaceId: string; userId: string; chatId: string }) {
    const task = this.chatTask(scope);
    if (task?.status !== "running") return;
    this.nodes
      .get(task.nodeKey)
      ?.transport?.send({ type: "session.cancel", taskId: task.id });
  }

  /** Ends a chat's session, if it has one. */
  closeChat(scope: { spaceId: string; userId: string; chatId: string }) {
    const task = this.chatTask(scope);
    if (task) this.settle(task, "cancelled", "The chat was closed.");
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
      screen: task.screen,
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
    if (!task || !isOpen(task)) return;
    this.nodes.get(task.nodeKey)?.transport?.send({ type: "session.cancel", taskId });
    this.settle(task, "cancelled", "Cancelled.");
  }

  private media(node: ConnectedNode, message: Uint8Array) {
    const { screenId, bytes } = decodeScreenMedia(message);
    const screen = this.screens.get(screenId);
    if (screen?.nodeKey === node.key) screen.viewer.send(bytes);
  }

  /** Ends a screen from the node's side. */
  private endScreen(screenId: string, error?: string) {
    const screen = this.screens.get(screenId);
    if (!screen) return;
    this.screens.delete(screenId);
    screen.viewer.close(error);
  }

  /** Ends a screen from the server's side, telling the node to stop streaming. */
  private closeScreen(screenId: string, error?: string) {
    const screen = this.screens.get(screenId);
    if (!screen) return;
    this.nodes.get(screen.nodeKey)?.transport?.send({ type: "screen.close", screenId });
    this.endScreen(screenId, error);
  }

  /** Opens an open task's screen for its own user. */
  openScreen(
    { spaceId, userId, taskId }: { spaceId: string; userId: string; taskId: string },
    viewer: ScreenViewer,
  ) {
    const task = this.tasks.get(taskId);
    const transport = task && this.nodes.get(task.nodeKey)?.transport;
    if (
      !task ||
      task.spaceId !== spaceId ||
      task.userId !== userId ||
      !isOpen(task) ||
      !task.screen
    ) {
      throw new Error(`No screen for remote task "${taskId}".`);
    }
    if (!transport) throw new Error("The node is offline.");
    const screenId = randomUUID();
    this.screens.set(screenId, { taskId, nodeKey: task.nodeKey, viewer });
    transport.send({ type: "screen.open", taskId, screenId });
    return {
      input: (events: ScreenInputEvent[]) => {
        if (!this.screens.has(screenId)) return;
        this.nodes
          .get(task.nodeKey)
          ?.transport?.send({ type: "screen.input", screenId, events });
      },
      close: (error?: string) => this.closeScreen(screenId, error),
    };
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
        if (task.chat)
          throw new Error("This agent runs a chat; there is no other agent.");
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
