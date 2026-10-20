import type { ChatMessage } from "#api/provider/types.ts";

/** A failed turn, carrying the messages it produced before failing. Kept apart from `core.ts` so the main thread does not load the agent shell. */
export class AgentTurnError extends Error {
  constructor(
    message: string,
    readonly messages: ChatMessage[],
  ) {
    super(message);
  }
}
