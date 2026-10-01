/**
 * The Discord bot: a Gateway connection per space with the `discord` extension
 * enabled and a `DISCORD_BOT_TOKEN` secret, answering @mentions and DMs with the
 * agent. It acts as its own ACL principal, so it reaches only what owners grant it.
 */

import { appPrincipal } from "#acl/apps.ts";
import { runAgentInWorker } from "#agent/agent.ts";
import type { ChatMessage } from "#api/provider/types.ts";
import { getLocalOrigin } from "#config";
import { listActiveSpaceIds } from "#db/auth/spaceIndex.ts";
import { openSpaceStore } from "#db/client/store.ts";
import { getAIChatSession, upsertAIChatSession } from "#db/space/aiChatSessions.ts";
import { getExtension } from "#db/space/extensions.ts";
import { getOAuthIntegrationByExternalAccount } from "#db/space/oauthIntegrations.ts";
import { getSpaceSecretMetadata, getSpaceSecretValue } from "#db/space/spaceSecrets.ts";
import { createJobToken } from "#jobs/jobToken.ts";
import { appLogger } from "#observability/logger.ts";

const EXTENSION_ID = "discord";
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
const DISCORD_CONTEXT =
  "These messages come from a Discord channel, each prefixed with its author. Your reply is posted there, so use Discord markdown.";

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

/** Connects one space's bot and keeps it connected; returns the function that stops it. */
export function connectDiscordBot(spaceId: string, botToken: string): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let botId = "";
  let session: { id: string; resumeUrl: string } | null = null;
  let seq: number | null = null;

  async function discord(path: string, body?: unknown): Promise<void> {
    const res = await fetch(`${DISCORD_API}${path}`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`Discord ${path} failed (${res.status}): ${await res.text()}`);
  }

  async function reply(message: DiscordMessage, text: string): Promise<void> {
    for (const [index, content] of splitDiscordMessage(text).entries()) {
      await discord(`/channels/${message.channel_id}/messages`, {
        content,
        // The agent's text must never ping @everyone or arbitrary users.
        allowed_mentions: { parse: [] },
        ...(index === 0 ? { message_reference: { message_id: message.id } } : {}),
      });
    }
  }

  async function answer(message: DiscordMessage, prompt: string): Promise<void> {
    const typing = setInterval(
      () => void discord(`/channels/${message.channel_id}/typing`).catch(() => {}),
      8000,
    );
    try {
      await discord(`/channels/${message.channel_id}/typing`);
      const store = await openSpaceStore(spaceId);
      // One conversation per channel; a Discord thread is a channel of its own.
      const chatId = `discord-${message.channel_id}`;
      const stored = await getAIChatSession(store, chatId, DISCORD_BOT_PRINCIPAL);
      // Credit only: the bot keeps its own access whoever it answers.
      const linked = await getOAuthIntegrationByExternalAccount(
        store,
        EXTENSION_ID,
        message.author.id,
      );
      const attribution = {
        app: EXTENSION_ID,
        onBehalfOf: {
          ...(linked ? { userId: linked.userId } : {}),
          name: message.author.global_name ?? message.author.username,
        },
      };
      const messages: ChatMessage[] = [
        ...((stored?.conversationHistory ?? []) as ChatMessage[]),
        { role: "user", content: `@${message.author.username}: ${prompt}` },
      ];
      const result = await runAgentInWorker({
        chatId,
        messages: [...messages, { role: "user", content: DISCORD_CONTEXT }],
        apiUrl: getLocalOrigin(),
        spaceId,
        connectedProviders: [],
        userId: DISCORD_BOT_PRINCIPAL,
        jobToken: createJobToken(
          spaceId,
          Date.now().toString(),
          DISCORD_BOT_PRINCIPAL,
          attribution,
        ),
        shellSnapshot: stored?.shellSnapshot ?? null,
      });
      await upsertAIChatSession(store, DISCORD_BOT_PRINCIPAL, {
        id: chatId,
        title: `Discord ${message.channel_id}`,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
        conversationHistory: [...messages, ...result.messages],
        shellSnapshot: result.shellSnapshot ?? null,
      });
      await reply(message, result.content.trim() || "Done, without a text reply.");
    } catch (error) {
      appLogger.error("Discord bot turn failed", { spaceId, error });
      await reply(
        message,
        `That failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearInterval(typing);
    }
  }

  // One turn at a time per channel, so turns append to the stored history in order.
  const queues = new Map<string, Promise<void>>();
  function enqueue(message: DiscordMessage, prompt: string): void {
    const key = message.channel_id;
    const next = (queues.get(key) ?? Promise.resolve())
      .then(() => answer(message, prompt))
      .catch((error) => appLogger.error("Discord bot reply failed", { spaceId, error }));
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
      appLogger.info("Discord bot connected", { spaceId, bot: ready.user.username });
      return;
    }
    if (type !== "MESSAGE_CREATE") return;

    const message = data as DiscordMessage;
    if (message.author.bot) return;
    const isDirect = message.guild_id === undefined;
    if (!isDirect && !message.mentions.some((user) => user.id === botId)) return;

    const prompt = message.content
      .replaceAll(`<@${botId}>`, "")
      .replaceAll(`<@!${botId}>`, "")
      .trim();
    if (prompt) enqueue(message, prompt);
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
          spaceId,
          code,
        });
        return;
      }
      // Discord asks for a 1–5 s pause before identifying again after an invalid session.
      await Bun.sleep(1000 + Math.random() * 4000);
    }
  })().catch((error) => appLogger.error("Discord bot stopped", { spaceId, error }));

  return () => {
    stopped = true;
    socket?.close(1000, "Stopped");
  };
}

/** A running bot, and the secret version it was started from. */
interface RunningBot {
  secretUpdatedAt: number;
  botToken: string;
  stop: () => void;
}

const bots = new Map<string, RunningBot>();
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let reconciling = false;

/** Starts, restarts and stops bots so they match each space's extension and secret. */
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

    for (const [spaceId, bot] of bots) {
      if (wanted.get(spaceId) !== bot.secretUpdatedAt) {
        bot.stop();
        bots.delete(spaceId);
      }
    }

    for (const [spaceId, secretUpdatedAt] of wanted) {
      // Stopped while this pass was reading: starting a bot now would outlive the server.
      if (!reconcileTimer) return;
      if (bots.has(spaceId)) continue;
      const botToken = await getSpaceSecretValue(
        await openSpaceStore(spaceId),
        SECRET_NAME,
      );
      if (!botToken) continue;
      // One bot token in two spaces would answer every message twice.
      const owner = [...bots].find(([, bot]) => bot.botToken === botToken);
      if (owner) {
        appLogger.error("Discord bot token is already used by another space", {
          spaceId,
          usedBy: owner[0],
        });
        bots.set(spaceId, { secretUpdatedAt, botToken: "", stop: () => {} });
        continue;
      }
      bots.set(spaceId, {
        secretUpdatedAt,
        botToken,
        stop: connectDiscordBot(spaceId, botToken),
      });
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
  for (const bot of bots.values()) bot.stop();
  bots.clear();
}
