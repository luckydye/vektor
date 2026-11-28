# Persistent bots and channels

## Goal

Replace private AI chats with persistent, space-wide bots. Each bot has a name, avatar, and role, and lives in one shared, Discord-style channel with threads. It remembers automatically and runs on the server or on a node. We build it by evolving `chat_session`, not by adding a bot subsystem.

## Model

A bot is a session with a persona. A thread is a session with a parent. No `bot` table.

| Kind | Row | Who uses it |
| --- | --- | --- |
| Bot channel | `visibility: space`, no parent | the UI |
| Thread | `visibility: space`, `parentSessionId` + `threadRootSeq` | the UI |
| Private session | `visibility: private` | jobs, schedules, the `vektor agent` CLI; never listed |

- One bot = one channel. `title` is the bot's name.
- Threads:
  - one level deep: the parent must be a channel
  - `threadRootSeq` must be a visible row of the parent
  - the server derives the title from the root message
- Deleting a channel deletes its threads and all their messages in one transaction.
- No channel is created automatically. An empty space shows "Create bot" to editors.
- The floating assistant, the session picker, and private chats in the UI are removed. Channels are the only AI surface in the UI. Private sessions remain only for API callers.

### Rename

`ai_chat_session` → `chat_session`, `aiChatSession` → `chatSession`, `db/space/aiChatSessions.ts` → `chatSessions.ts`, `AIChatSession*` → `ChatSession*`, `/ai-chat/sessions` → `/chat/sessions`. This includes `ApiClient.ts` and the `api/` package. All in one step.

### `chat_session` columns added

```
visibility        "space" | "private"   default "private"
access            "viewer" | "editor"   minimum space role to post; forced "editor" on a node
rolePrompt        text | null           null = general assistant
avatar            text | null
memory            text                  default ''
memoryThroughSeq  integer               default 0
repliedThroughSeq integer               default 0; last user row answered
parentSessionId   text | null
threadRootSeq     integer | null
nodeAgent         text | null           pinned agent on `node`
```

`shellSnapshot`, `source`, `node`, `createdBy` (the bot owner), and timestamps stay. `messages`, `conversationHistory`, and `lastMessageRole` are dropped.

### `chat_message`

One append-only log in the model's message shape. The UI renders the same rows.

```
seq        integer primary key autoincrement   global, so threadRootSeq is unambiguous
sessionId  text, index (session_id, seq)
role       "user" | "assistant" | "tool"
authorId   text | null                         the poster; null for the bot
content    text
visible    boolean                             false for model-only rows, e.g. additional context
metadata   text                                attachments, images, tool calls, error flag, and the poster's documentId and timeZone
createdAt
```

- A "user row" is `role: user` with `authorId` set. Only user rows count toward replies.
- The model gets the composed prompt (below), then `memory`, then the rows after `memoryThroughSeq`. Each user row goes to the model prefixed `Name: `, on the server and on nodes alike.
- A turn's rows are inserted when the turn ends, as today. The live view comes from the stream.

## Identity

- **Private session:** runs as its creator, exactly as today. That means the creator's job token, provider, profile, and integrations, and only the creator can access it.
- **Channel or thread:** runs as the bot.
  - The bot is its own ACL principal (`bot:<sessionId>`), granted `access` on the space the way access tokens get their own id (`guards.ts:307`).
  - Its job token carries that principal. The existing ACL checks then limit it to what a plain viewer or editor of the space can see and do, on every path, with no new token claim.
  - Provider and node: the owner's.
  - Profile and personal integrations: none.
  - If the owner is no longer an editor of the space, turns fail with an error row.

## Turns

All sessions go through one loop per `spaceId:sessionId`, registered without an await between the check and the registration, as `startChatTurn` does today.

1. Posting appends a user row. If no turn is registered, register one.
2. The turn records `target`, the highest user-row `seq`, and answers every user row up to it. Rows posted after that wait for the next round.
3. When the turn ends, write its rows, then set `repliedThroughSeq = target`. Failed and cancelled turns write an error row and also advance; nothing is retried.
4. Compact memory if needed (see Memory).
5. If a user row exists past `target`, run again from step 2 inside the same registry entry. Mark it done only after this final check finds nothing.

- `session/prompt` appends, then streams the round that answers your row. `agentPrompt`, the CLI, and schedules keep working unchanged. Other viewers attach with `session/load`.
- A realtime event fires when a round starts and ends, so the sidebar and other viewers refresh.
- Anyone who can post can cancel. A cancel stops the whole batch, including other people's rows, and those rows count as answered.
- On startup, sessions with user rows past `repliedThroughSeq` get an "interrupted by a restart" row, and the watermark advances.
- A channel and its threads are separate sessions, so their turns run in parallel.

## Memory

Fully automatic; no UI.

- Memory is compacted at step 4 of the turn loop. That makes it exclusive with turns, so a turn never sees memory and its watermark out of step.
- If rows after `memoryThroughSeq` exceed a token budget, summarize the oldest chunk into `memory` and advance `memoryThroughSeq`. Chunks end just before a user row, so a tool call is never split from its result.
- Uses `callModel` + `reserveAITokens` with the session's provider.
- A thread's prompt also gets the parent's memory and the root message.
- The profile updater runs only for private sessions.

## Prompt

```
core system prompt
  + ## Bot Role            rolePrompt
  + ## Bot Memory          memory (+ parent memory and root message for threads)
  + ## Space Instructions
turn context: each user row's own documentId and timeZone
```

Built fresh every turn. In channels, attached documents are visible to the model only if the bot principal can read them.

## Nodes

- A bot is created on a runner the creator may use (`agentRunners`: their own nodes, plus the space's HTTP runners when they own the space), with a pinned `nodeAgent`. `access` is forced to `editor`. A warning says space editors will run commands on that machine.
- Threads copy `node` + `nodeAgent`. A missing node or agent fails the turn with an error row; nothing falls back silently.
- Runner sessions are keyed by session (drop `userId` from `chatKey`) and opened with the owner's scope and the bot's token. Identity never changes between turns, so the screen checks still hold, and only the owner sees the screen.
- `promptChat` and `open` take the pinned agent instead of `agents[0]`.
- Whenever `promptChat` reports `fresh` (first prompt, idle timeout, or the agent failed), send a preamble: role, memory, the root message for threads, and the last few `Name:`-prefixed rows. Remove the "does not remember earlier messages" status in `runners/chat.ts`.
- Offline, at-capacity, and timeout show as error rows.

## API

- `session/new` accepts `visibility`, `rolePrompt`, `avatar`, `access`, `parentSessionId`, `node`, and `nodeAgent`.
  - Visibility defaults to `private`.
  - Creating a channel requires editor. Creating a thread requires posting rights on the parent.
  - `title` is required for channels and private sessions, and derived for threads.
- `session/prompt`, `load`, and `cancel` check channel access for space sessions and `createdBy` for private ones.
- Session list: channels with thread counts. Threads are listed by `parentSessionId`. Messages have a paged list endpoint.
- Reading a channel requires viewer. Editing and deleting a bot requires editor.
- Agent schedules get an optional target `sessionId`. They post through `agentPrompt`, so the schedule's user must be allowed to post there.

## UI

- Sidebar section with the bot channels. A channel shows the timeline, avatars, composer, streaming state, and node status.
- Bot editor: name, avatar, role prompt, run target, access.
- "Reply in thread" on a message, a reply count on the root, and the thread in a side pane.
- On realtime "round started", viewers who didn't post attach with `session/load`.

## Migration

Migration 24 must work on fresh databases (where the baseline already creates `chat_session`) and on old ones:

1. If `ai_chat_session` exists:
   - If `chat_session` also exists (a database from before the squash), drop it if it is empty and throw if it is not.
   - Rename `ai_chat_session` to `chat_session`.
2. Delete all existing sessions. Old chats and job sessions are not kept, and reusing an old job `sessionId` fails as not found.
3. Drop `messages`, `conversation_history`, and `last_message_role` if they exist.
4. Add the new columns with the `columnExists` helpers. Create `chat_message` and its `(session_id, seq)` index with raw SQL.

## Later

- Private threads: visible to their creator only, replacing personal chats.
- Thread outcomes folding into the channel's memory.
- Transferring a bot when its owner leaves.
