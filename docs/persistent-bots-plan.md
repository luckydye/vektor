# Persistent bots and channels

## Goal

Replace private AI chats with persistent, space-wide bots. Each bot has a name, avatar, and role, and lives in one shared, Discord-style channel with threads. It remembers automatically and runs on the server or on a node. We build it by evolving `chat_session`, not by adding a bot subsystem.

## Model

A bot is a session with a persona. A thread is a session with a parent. No `bot` table.

| Surface | Session row |
| --- | --- |
| Bot channel | `visibility: space`, no parent |
| Thread | `visibility: space`, `parentSessionId` + `threadRootSeq` |
| Legacy chat / job session | `visibility: private`, never listed |

- One bot = one channel. `title` is the bot's name; a thread's title is the root message's opening text.
- Threads are one level deep, and `threadRootSeq` must belong to the parent. Deleting a channel deletes its threads and messages.
- No channel is created automatically. An empty space shows "Create bot" to editors.
- The floating assistant, the session picker, and private chats are removed. Channels are the only AI surface.

### Rename

`ai_chat_session` → `chat_session`, `aiChatSession` → `chatSession`, `db/space/aiChatSessions.ts` → `chatSessions.ts`, `AIChatSession*` → `ChatSession*`, `/ai-chat/sessions` → `/chat/sessions`. All in one step.

### `chat_session` columns added

```
visibility        "space" | "private"   default "private"; session/new sets "space"
access            "editors" | "members" who may post; default "members", "editors" when on a node
rolePrompt        text | null           null = general assistant
avatar            text | null
memory            text                  default ''
memoryThroughSeq  integer               default 0
repliedThroughSeq integer               default 0; last message the bot has answered
parentSessionId   text | null
threadRootSeq     integer | null
nodeAgent         text | null           pinned agent on `node`
```

`shellSnapshot`, `source`, `node`, `createdBy` (the bot owner), and timestamps stay. `messages`, `conversationHistory`, and `lastMessageRole` become `@deprecated`.

### `chat_message`

One append-only log in the model's message shape. The UI renders the same rows.

```
seq         integer primary key autoincrement   (global, so threadRootSeq is unambiguous)
sessionId   text, index (sessionId, seq)
role        "user" | "assistant" | "tool"
authorId    text | null                         null for the bot
content     text
visible     boolean                             false for model-only rows, e.g. additional context
metadata    text                                attachments, images, tool calls / tool call id, error flag
createdAt
```

The UI shows visible rows. The model gets the composed system prompt (below), plus `memory`, plus the rows after `memoryThroughSeq`. No system prompt is stored.

## Turns

- A turn runs **as the bot**, not as whoever posted:
  - the AI provider is the bot owner's
  - the node is the owner's
  - the job token belongs to the owner, limited to documents the whole space can view
  - documents can be written only when `access` is `editors`
  - personal OAuth integrations and the user profile are not used
- One turn at a time per session, keyed `spaceId:sessionId`. Posting appends a row. If the session is idle, a turn starts; when it ends, the bot answers every row after `repliedThroughSeq`, then advances it.
- A failed or cancelled turn writes an error row and advances `repliedThroughSeq`. It is never retried.
- On startup, sessions with unanswered rows get an "interrupted by a restart" row, and `repliedThroughSeq` advances. This adapts `failInterruptedAIChatTurns`.
- Anyone who can post can cancel.
- The channel and its threads are separate sessions, so their turns run in parallel.

## Streaming

- `session/prompt` appends and returns `{ seq }`; it does not stream.
- A realtime event fires on turn start, turn end, and every message insert. Any viewer attaches to the running turn with `session/load` (existing turn registry and SSE replay), and refetches rows when the turn ends.

## Memory

Fully automatic; no UI.

1. After a turn, if rows after `memoryThroughSeq` exceed a token budget, summarize the oldest chunk into `memory` and advance `memoryThroughSeq`.
2. Single-flight per session and idempotent through the watermark. Uses `callModel` + `reserveAITokens` with the bot owner's provider.
3. A thread's prompt also gets the parent's memory and the root message. In v1, threads do not fold back into the channel's memory.
4. The profile updater does not run for channel turns.

## Prompt

```
core system prompt
  + ## Bot Role            rolePrompt
  + ## Bot Memory          memory (+ parent memory and root message for threads)
  + ## Space Instructions
turn context: speaker names, and the document if one is attached (space-visible documents only)
```

Built fresh every turn.

## Nodes

- A bot channel is created on one of the creator's own nodes (`agentRunners`), with a pinned `nodeAgent`. Creating it shows a warning that space members will run commands on that machine.
- Threads copy `node` + `nodeAgent`. Nothing falls back silently: a missing node or agent fails the turn with a visible error row.
- Runner sessions are keyed by session, without `userId` in `chatKey`. They are opened with the owner's scope and the bot token, so identity never changes between turns, and the existing mailbox and screen checks still hold. Only the owner sees the screen.
- `promptChat` and `open` take the pinned agent instead of `agents[0]`.
- On a fresh runner session, send a preamble: role, memory, the root message (for threads), and the last few author-prefixed rows. Later prompts are `Speaker: message`. When a session idles out, the next prompt rehydrates it the same way.
- Offline, at-capacity, and timeout show as error rows.

## API

- `session/new` accepts `rolePrompt`, `avatar`, `access`, `parentSessionId`, `threadRootSeq`, `node`, and `nodeAgent`. Requires editor; threads require posting rights.
- `session/prompt`, `load`, and `cancel` check channel access instead of `createdBy`.
- Session list: channels with thread counts. Threads are listed by `parentSessionId`. Messages have a paged list endpoint.
- Editing and deleting a bot requires editor.
- Agent schedules get an optional target `sessionId`, so they post into a channel.

## UI

- Sidebar section with the bot channels. A channel shows the timeline, avatars, composer, streaming state, and node status.
- Bot editor: name, avatar, role prompt, run target, access.
- "Reply in thread" on a message, a reply count on the root, and the thread in a side pane.

## Migration

Migration 24 must work both on fresh databases (where the baseline already creates `chat_session`) and on old ones:

1. If `ai_chat_session` exists and `chat_session` does not, rename it. If both exist (a database from before the squash), drop the empty `chat_session` and rename.
2. Add the columns with the `columnExists` helpers. Create `chat_message`.
3. Do not backfill. Existing chats stay as hidden `private` rows. A follow-up migration drops them along with the deprecated JSON columns.

## Later

- Private threads: visible to their creator only, replacing personal chats.
- Thread outcomes folding into the channel's memory.
- Transferring a bot when its owner leaves.
