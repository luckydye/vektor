/**
 * The Discord bot: one Gateway connection per bot token, shared by every space
 * with the `discord` extension enabled and that token as its `DISCORD_BOT_TOKEN`
 * secret. It answers @mentions and DMs with an agent working across those spaces.
 */

import { appPrincipal, type Attribution } from "#acl/apps.ts";
import { runAgentInWorker } from "#agent/agent.ts";
import type { AgentSpace } from "#agent/tools.ts";
import type { AIProvider, ChatMessage } from "#api/provider/types.ts";
import { getLocalOrigin } from "#config";
import { listActiveSpaceIds } from "#db/auth/spaceIndex.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getExtension } from "#db/space/extensions.ts";
import { getOAuthIntegrationByExternalAccount } from "#db/space/oauthIntegrations.ts";
import { getSpaceSecretMetadata, getSpaceSecretValue } from "#db/space/spaceSecrets.ts";
import { getSpace } from "#db/space/spaces.ts";
import { resolveUserAIProvider } from "#integrations/aiProvider.ts";
import { createJobToken } from "#jobs/jobToken.ts";
import { appLogger } from "#observability/logger.ts";

const EXTENSION_ID = "discord";
// In every space, the bot acts as this principal with that space's grants.
const DISCORD_BOT_PRINCIPAL = appPrincipal(EXTENSION_ID);
const SECRET_NAME = "DISCORD_BOT_TOKEN";
const RECONCILE_INTERVAL_MS = 30_000;
const DISCORD_API = "https://discord.com/api/v10";
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
// GUILD_MESSAGES | DIRECT_MESSAGES. Mentions and DMs carry their content without the privileged intent.
const INTENTS = (1 << 9) | (1 << 12);
// Authentication failed, or intents/shards the bot may not use: reconnecting cannot help.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const MAX_MESSAGE_LENGTH = 2000;
// Earlier messages of the channel the agent sees: the conversation lives in Discord, not in Vektor.
const HISTORY_LIMIT = 30;
// Arguments that say what a tool call was about, most telling first.
const KEY_ARGUMENTS = [
  "query",
  "documentId",
  "id",
  "slug",
  "title",
  "path",
  "name",
  "command",
];
const MAX_FOOTER_LENGTH = 400;

interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; username: string; global_name?: string | null; bot?: boolean };
  mentions: Array<{ id: string }>;
}

interface GatewayPayload {
  op: number;
  d: unknown;
  s: number | null;
  t: string | null;
}

/** Splits `text` into Discord-sized messages, preferring line breaks. */
export function splitDiscordMessage(text: string): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > MAX_MESSAGE_LENGTH) {
    const lineBreak = rest.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    const cut = lineBreak > 0 ? lineBreak : MAX_MESSAGE_LENGTH;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  parts.push(rest);
  return parts;
}

/**
 * One Discord subtext line naming the tools a turn called, so later turns read
 * back what it did; results are not kept, the agent calls again for those.
 */
export function toolFooter(messages: ChatMessage[], spaces: AgentSpace[]): string | null {
  const calls = messages.flatMap((message) =>
    (message.tool_calls ?? []).map((call) => {
      const args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      const key = KEY_ARGUMENTS.map((name) => args[name]).find(
        (value) => typeof value === "string" && value,
      ) as string | undefined;
      const space = spaces.find((candidate) => candidate.id === args.space);
      const subject = key ? ` ${key.length > 40 ? `${key.slice(0, 40)}…` : key}` : "";
      return `${call.function.name}${subject.replaceAll("\n", " ")}${space ? ` (${space.name})` : ""}`;
    }),
  );
  const unique = calls.filter((call, index) => calls[index - 1] !== call);
  if (unique.length === 0) return null;
  const footer = unique.join(" · ");
  return `-# ${footer.length > MAX_FOOTER_LENGTH ? `${footer.slice(0, MAX_FOOTER_LENGTH)}…` : footer}`;
}

/**
 * The model connection of the person behind a message, from the first space
 * where they linked Discord and picked a model; null runs on the instance's.
 */
async function linkedAIProvider(
  spaces: Array<{ id: string; linkedUserId: string | null }>,
): Promise<AIProvider | null> {
  for (const space of spaces) {
    if (!space.linkedUserId) continue;
    const provider = await resolveUserAIProvider(space.id, space.linkedUserId);
    if (provider.provider === "integration") return provider;
  }
  return null;
}

/** What the agent is told about where it is: Discord, and the spaces it can act in. */
function discordContext(spaces: AgentSpace[]): string {
  const where =
    "These messages come from a Discord channel, each prefixed with its author. Your reply is posted there, so use Discord markdown. A last line starting with -# in your earlier replies lists the tools you called that turn; call them again if you need their results.";
  if (spaces.length === 1)
    return `${where} You work in the Vektor space "${spaces[0].name}".`;
  const list = spaces.map((space) => `- ${space.name} (${space.id})`).join("\n");
  return `${where} You work in these Vektor spaces; pass a tool's \`space\` to pick one, the first is the default:\n${list}`;
}

/**
 * Connects a bot token and keeps it connected; returns the function that stops it.
 * `spaces` is read per message, so spaces joining or leaving take effect at once.
 */
export function connectDiscordBot(botToken: string, spaces: () => string[]): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let botId = "";
  let session: { id: string; resumeUrl: string } | null = null;
  let seq: number | null = null;

  async function discord(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(`${DISCORD_API}${path}`, {
      method,
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Discord ${path} failed (${res.status}): ${await res.text()}`);
    }
    return res.status === 204 ? null : await res.json();
  }

  async function reply(message: DiscordMessage, text: string): Promise<void> {
    for (const [index, content] of splitDiscordMessage(text).entries()) {
      await discord("POST", `/channels/${message.channel_id}/messages`, {
        content,
        // The agent's text must never ping @everyone or arbitrary users.
        allowed_mentions: { parse: [] },
        ...(index === 0 ? { message_reference: { message_id: message.id } } : {}),
      });
    }
  }

  function authorLine(message: DiscordMessage): string | null {
    const text = message.content
      .replaceAll(`<@${botId}>`, "")
      .replaceAll(`<@!${botId}>`, "")
      .trim();
    return text ? `@${message.author.username}: ${text}` : null;
  }

  /** The channel before `message`, oldest first; other people's text is blank unless it mentions the bot. */
  async function channelHistory(message: DiscordMessage): Promise<ChatMessage[]> {
    const earlier = (await discord(
      "GET",
      `/channels/${message.channel_id}/messages?before=${message.id}&limit=${HISTORY_LIMIT}`,
    )) as DiscordMessage[];
    return earlier.reverse().flatMap((entry): ChatMessage[] => {
      if (entry.author.id === botId)
        return [{ role: "assistant", content: entry.content }];
      const line = authorLine(entry);
      return line ? [{ role: "user", content: line }] : [];
    });
  }

  /**
   * Each space with a token crediting this author, as the person they linked
   * there if any; `linkedUserId` is that person.
   */
  async function agentSpaces(
    message: DiscordMessage,
  ): Promise<Array<AgentSpace & { linkedUserId: string | null }>> {
    const timestamp = Date.now().toString();
    return await Promise.all(
      spaces().map(async (spaceId) => {
        const space = await getSpace(spaceId);
        if (!space) throw new Error(`Space ${spaceId} not found`);
        const linked = await getOAuthIntegrationByExternalAccount(
          await openSpaceStore(spaceId),
          EXTENSION_ID,
          message.author.id,
        );
        // Credit only: the bot keeps its own access whoever it answers.
        const attribution: Attribution = {
          app: EXTENSION_ID,
          onBehalfOf: {
            ...(linked ? { userId: linked.userId } : {}),
            name: message.author.global_name ?? message.author.username,
          },
        };
        return {
          id: spaceId,
          name: space.name,
          jobToken: createJobToken(
            spaceId,
            timestamp,
            DISCORD_BOT_PRINCIPAL,
            attribution,
          ),
          linkedUserId: linked?.userId ?? null,
        };
      }),
    );
  }

  async function answer(message: DiscordMessage, line: string): Promise<void> {
    const typing = setInterval(
      () =>
        void discord("POST", `/channels/${message.channel_id}/typing`).catch(() => {}),
      8000,
    );
    try {
      await discord("POST", `/channels/${message.channel_id}/typing`);
      const spaceList = await agentSpaces(message);
      const [primary] = spaceList;
      if (!primary) throw new Error("No space uses this bot any more");
      // Only people with a Vektor account behind them get answers.
      if (spaceList.every((space) => !space.linkedUserId)) {
        await reply(
          message,
          "I only answer people who linked their Discord account in Vektor: Settings → Integrations → Discord.",
        );
        return;
      }
      const history = await channelHistory(message);
      // Pays with the author's own model connection where they linked Discord.
      const provider = await linkedAIProvider(spaceList);
      const result = await runAgentInWorker({
        chatId: `discord-${message.channel_id}`,
        messages: [
          ...history,
          { role: "user", content: line },
          { role: "user", content: discordContext(spaceList) },
        ],
        apiUrl: getLocalOrigin(),
        spaceId: primary.id,
        connectedProviders: [],
        userId: DISCORD_BOT_PRINCIPAL,
        jobToken: primary.jobToken,
        ...(provider ? { provider } : {}),
        ...(spaceList.length > 1 ? { spaces: spaceList } : {}),
      });
      const footer = toolFooter(result.messages, spaceList);
      const text = result.content.trim() || "Done, without a text reply.";
      await reply(message, footer ? `${text}\n${footer}` : text);
    } catch (error) {
      appLogger.error("Discord bot turn failed", { error });
      await reply(
        message,
        `That failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearInterval(typing);
    }
  }

  // One turn at a time per channel, so each turn sees the replies before it.
  const queues = new Map<string, Promise<void>>();
  function enqueue(message: DiscordMessage, line: string): void {
    const key = message.channel_id;
    const next = (queues.get(key) ?? Promise.resolve())
      .then(() => answer(message, line))
      .catch((error) => appLogger.error("Discord bot reply failed", { error }));
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) queues.delete(key);
    });
  }

  function onDispatch(type: string | null, data: unknown): void {
    if (type === "READY") {
      const ready = data as {
        session_id: string;
        resume_gateway_url: string;
        user: { id: string; username: string };
      };
      session = { id: ready.session_id, resumeUrl: ready.resume_gateway_url };
      botId = ready.user.id;
      appLogger.info("Discord bot connected", {
        bot: ready.user.username,
        spaces: spaces(),
      });
      return;
    }
    if (type !== "MESSAGE_CREATE") return;

    const message = data as DiscordMessage;
    if (message.author.bot) return;
    const isDirect = message.guild_id === undefined;
    if (!isDirect && !message.mentions.some((user) => user.id === botId)) return;

    const line = authorLine(message);
    if (line) enqueue(message, line);
  }

  /** Runs one gateway connection, resuming `session` when set, and resolves with its close code. */
  function connect(): Promise<number> {
    return new Promise((resolve) => {
      const ws = new WebSocket(
        session ? `${session.resumeUrl}/?v=10&encoding=json` : GATEWAY_URL,
      );
      socket = ws;
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      let acknowledged = true;
      const send = (op: number, d: unknown) => ws.send(JSON.stringify({ op, d }));

      ws.onmessage = (event) => {
        const payload = JSON.parse(String(event.data)) as GatewayPayload;
        if (payload.s !== null) seq = payload.s;

        if (payload.op === 0) {
          onDispatch(payload.t, payload.d);
        } else if (payload.op === 10) {
          const interval = (payload.d as { heartbeat_interval: number })
            .heartbeat_interval;
          const beat = () => {
            // No ack since the last beat means a zombie connection; a non-1000 close keeps the session resumable.
            if (!acknowledged) return ws.close(4000, "Heartbeat not acknowledged");
            acknowledged = false;
            send(1, seq);
            heartbeat = setTimeout(beat, interval);
          };
          heartbeat = setTimeout(beat, interval * Math.random());
          if (session) {
            send(6, { token: botToken, session_id: session.id, seq });
          } else {
            send(2, {
              token: botToken,
              intents: INTENTS,
              properties: { os: process.platform, browser: "vektor", device: "vektor" },
            });
          }
        } else if (payload.op === 11) {
          acknowledged = true;
        } else if (payload.op === 1) {
          send(1, seq);
        } else if (payload.op === 7) {
          ws.close(4000, "Reconnect requested");
        } else if (payload.op === 9) {
          if (!payload.d) {
            session = null;
            seq = null;
          }
          ws.close(4000, "Invalid session");
        }
      };
      ws.onclose = (event) => {
        clearTimeout(heartbeat);
        resolve(event.code);
      };
    });
  }

  void (async () => {
    while (!stopped) {
      const code = await connect();
      if (stopped) return;
      if (FATAL_CLOSE_CODES.has(code)) {
        appLogger.error("Discord rejected the bot; fix the token or intents", {
          spaces: spaces(),
          code,
        });
        return;
      }
      // Discord asks for a 1–5 s pause before identifying again after an invalid session.
      await Bun.sleep(1000 + Math.random() * 4000);
    }
  })().catch((error) => appLogger.error("Discord bot stopped", { error }));

  return () => {
    stopped = true;
    socket?.close(1000, "Stopped");
  };
}

/** A space's bot token, and the secret version it was read from. */
interface SpaceBotToken {
  secretUpdatedAt: number;
  botToken: string;
}

const spaceTokens = new Map<string, SpaceBotToken>();
/** Running connections, by bot token. */
const connections = new Map<string, () => void>();
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconciling = false;

/** The spaces sharing `botToken`, in a stable order so the default space stays put. */
function spacesUsing(botToken: string): string[] {
  return [...spaceTokens]
    .filter(([, entry]) => entry.botToken === botToken)
    .map(([spaceId]) => spaceId)
    .sort();
}

/** Starts and stops connections so each bot token in use has exactly one. */
async function reconcileDiscordBots(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    const wanted = new Map<string, number>();
    for (const spaceId of await listActiveSpaceIds()) {
      try {
        const store = await openSpaceStore(spaceId);
        if (!(await getExtension(store, EXTENSION_ID))) continue;
        const secret = await getSpaceSecretMetadata(store, SECRET_NAME);
        if (secret) wanted.set(spaceId, secret.updatedAt.getTime());
      } catch (error) {
        appLogger.error("Discord bot reconcile failed for space", { spaceId, error });
      }
    }

    for (const [spaceId, entry] of spaceTokens) {
      if (wanted.get(spaceId) !== entry.secretUpdatedAt) spaceTokens.delete(spaceId);
    }
    for (const [spaceId, secretUpdatedAt] of wanted) {
      if (spaceTokens.has(spaceId)) continue;
      const botToken = await getSpaceSecretValue(
        await openSpaceStore(spaceId),
        SECRET_NAME,
      );
      if (botToken) spaceTokens.set(spaceId, { secretUpdatedAt, botToken });
    }

    const tokens = new Set([...spaceTokens.values()].map((entry) => entry.botToken));
    for (const [botToken, stop] of connections) {
      if (tokens.has(botToken)) continue;
      stop();
      connections.delete(botToken);
    }
    // Stopped while this pass was reading: starting a bot now would outlive the server.
    if (!reconcileTimer) return;
    for (const botToken of tokens) {
      if (connections.has(botToken)) continue;
      connections.set(
        botToken,
        connectDiscordBot(botToken, () => spacesUsing(botToken)),
      );
    }
  } finally {
    reconciling = false;
  }
}

export function startDiscordBots(): void {
  if (reconcileTimer) return;
  const reconcile = () =>
    void reconcileDiscordBots().catch((error) =>
      appLogger.error("Discord bot reconcile failed", { error }),
    );
  reconcileTimer = setInterval(reconcile, RECONCILE_INTERVAL_MS);
  reconcileTimer.unref?.();
  reconcile();
}

export function stopDiscordBots(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  for (const stop of connections.values()) stop();
  connections.clear();
  spaceTokens.clear();
}
