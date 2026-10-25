import type { SessionStopReason } from "#agent/nodes/protocol.ts";

/** How an agent's MCP client starts the Vektor MCP server for one task. */
export type McpLaunch = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** What a node lets its agents do without asking, and how it asks. */
export type Policy = {
  /** Sessions start here, and requests naming a path outside it are refused. */
  workdir: string;
  /** Refuses anything that could change files or run commands. */
  readonly: boolean;
  /** Allows what is not refused, without asking. */
  autoApprove: boolean;
  /** Lets shell commands through without asking each one. */
  allowShell: boolean;
  /** Puts a question to the person at the node; false when there is nobody to ask. */
  confirm(question: string): Promise<boolean>;
};

export type SessionInit = {
  taskId: string;
  cwd: string;
  /** Null when the agent has no way to reach the Vektor server's tools. */
  mcp: McpLaunch | null;
  policy: Policy;
  spaceId: string;
  jobToken: string;
};

export type PromptResult = { stopReason: SessionStopReason; error?: string };

/** One task's conversation with an agent. */
export interface AdapterSession {
  /** Runs one turn, passing the agent's ACP `session/update`s on as they arrive. */
  prompt(
    text: string,
    onUpdate: (update: Record<string, unknown>) => void,
  ): Promise<PromptResult>;
  cancel(): void;
  /** Ends the session and whatever it started. */
  close(): Promise<void>;
}

export interface Adapter {
  open(init: SessionInit): Promise<AdapterSession>;
}
