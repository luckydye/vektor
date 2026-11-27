# Persistent bots and channels

## What we want

- Space-scoped, persistent bots with a name, avatar, and a specific role.
- A bot behaves like a Discord text channel: one continuous, shared timeline, not a new chat per conversation.
- Channels support threads that branch off messages.
- The bot remembers things automatically. No manual memory editing, no "save this" step.
- A bot can run on the server's agent or on an external node/runner, just like a chat session can.
- **Bot channels replace private chats.** Every user-facing conversation is a channel or a thread. There is no parallel private assistant, session picker, or short-lived chat surface left behind.
- This evolves `chat_session` (renamed from `ai_chat_session`) and the existing chat system. We do not build a parallel "bot" subsystem.

## Shape: one session, two user-facing presentations

Do not add a `bot` table. A bot is a session with a persona. A thread is a session with a parent.

| Surface | Session row |
| --- | --- |
| Bot channel | `visibility: space`, `rolePrompt` set, no parent |
| Thread | `visibility: space`, `parentSessionId` + `threadRootSeq` |

Threads are space-visible in v1. Private threads are a later extension.

One bot = one channel = one session. Multiple channels per bot, shared bot templates, and cross-space bots are out of scope for now.

### Naming

Rename the table and its code symbols as part of the same evolution:

- `ai_chat_session` → `chat_session`
- `aiChatSession` → `chatSession`
- `db/space/aiChatSessions.ts` → `db/space/chatSessions.ts`
- `AIChatSession*` types → `ChatSession*`
- `/api/v1/spaces/:spaceId/ai-chat/sessions` → `/chat/sessions` when the old chat UI is removed

The SQLite migration is a rename, not a rebuild: `ALTER TABLE ai_chat_session RENAME TO chat_session`. Rows and ids are preserved.

There is no private-chat row shape. In v1, `visibility: private` is only for hidden legacy rows and internal job sessions, which are never listed as channels. Private threads are a later extension and will use the same value for user-facing threads.

### `chat_session` additions

```
visibility: "space" | "private"     default "space"; private threads are later, private is legacy/job until then
rolePrompt: text | null             the bot's persona; null is a general assistant
avatar: text | null
memory: text                        automatic rolling summary
memoryThroughSeq: integer           last message included in memory
parentSessionId: text | null        a thread's channel
threadRootSeq: integer | null       the parent message the thread branched from
nodeAgent: text | null              the ACP agent on `node`; pinned for bot channels
```

Existing fields keep their meaning: `title`, `createdBy`, `source` (`chat` / `job`), `node`, timestamps.

Threads are one level deep. `session/new` refuses a parent that is itself a thread. Deleting a channel deletes its threads.

### `chat_message`: append-only log

Replace the `messages` / `conversationHistory` JSON blobs with rows.

```
seq           integer primary key autoincrement
sessionId     text, indexed with seq
role          "user" | "assistant" | "system" | "tool"
authorType    "user" | "bot" | "system"
authorId      text | null            null for the bot
content       text
visible       boolean                false for model-only context
metadata      text                   attachments, tool name/id/phase, model/tools
createdAt
```

- The UI reads `visible` rows. The model reads the session's `systemPrompt` plus rows in `seq` order.
- Existing `messages` and `conversationHistory` are backfilled once, then marked deprecated and removed in a follow-up migration.
- Append-only rows remove the read-modify-write race that a shared channel would otherwise have.

## No default channel

No Assistant channel is created automatically, for new or existing spaces. A space starts with no channels, and a space that removes its last bot has no AI surface until someone creates another.

- The channel list has an empty state with a "Create bot" action for editors.
- Creating the first bot is a normal channel create; it can have any role prompt. An empty role prompt behaves as a general assistant.
- The old floating assistant, private transcript, and session picker are removed. Channels are the only AI surface.

Document-scoped questions from the old panel become "ask about this document" prompts posted into a channel or thread, with the document as turn context. Replies are shared, so the shared-document scope below applies.

## Turns

- One turn at a time per session. This is already true for chats; it becomes essential for shared channels.
- A member posts: append the message. If the session is idle, start the bot turn.
- If a turn is running, the message waits. When the turn finishes, the bot answers everything posted since its last reply, in order.
- The queue is keyed `spaceId:sessionId` (not by user).
- After a restart, the next incoming message picks up the unanswered backlog. There is no background retry loop.
- A failed turn writes an error message and advances the reply watermark. Never retry forever.
- Threads are separate sessions, so a channel turn and a thread turn can run at the same time.

## Streaming and live updates

- Reuse the existing ACP turn registry and SSE stream.
- Key the active turn by `spaceId:sessionId` instead of `spaceId:userId:sessionId`.
- `session/load` validates channel/thread access and lets any space member attach to the running turn.
- The poster gets live streaming. Other viewers get a realtime notification when the final message row is written, then refetch.
- Channel and thread message inserts also send a realtime event so the sidebar and timeline update without polling.

## Automatic memory

Nothing manual. The full transcript stays in `chat_message`; only what the model sees is bounded.

1. After a turn, if unsummarized rows exceed a threshold (count or estimated tokens), summarize the oldest chunk into `session.memory` and advance `memoryThroughSeq`.
2. Compaction is single-flight per session and idempotent through the watermark.
3. The model gets `session.memory` plus rows after `memoryThroughSeq`.
4. Use the existing `callModel` + `reserveAITokens` path, modeled on `agent/profileUpdater.ts`.
5. For a thread, the prompt includes the parent channel's memory and the root message in addition to the thread's own memory. A thread's outcome may fold back into the channel's memory automatically, so the bot remembers decisions made in threads. That write is serialized with the channel's own compaction.
6. No memory UI. Memory is entirely internal.

## Prompt composition

Live composition, not frozen into the first turn:

```
core system prompt
  + ## Bot Role          (session.rolePrompt, replaced each turn)
  + ## Bot Memory        (session.memory)
  + integrations
  + user profile
  + ## Space Instructions
```

For a thread, add the parent's memory and root message. For shared channels, omit the per-user profile from the system prompt; put the current speaker in the turn context instead.

## Nodes and external runners

`node` already lives on the session. Bot channels and threads use it the same way chats do.

- A bot channel picks its node and the agent on that node at creation. Both are fixed, so the bot does not change engines when the node reorders its adapters.
- A thread copies the parent channel's node and nodeAgent at creation. No silent fallback to the internal agent if the node is unavailable.
- `session/new` refuses a node the creator cannot use, or an agent the node does not offer. A missing pinned agent fails the turn instead of picking another.
- Scheduled posts into a channel run on that channel's node.

The runner path needs changes because it assumes a private, single-user chat:

1. **Key the runner session by session, not user.** `chatKey` currently includes `userId`; drop it so a channel does not open one runner session per member.
2. **Identity is per turn.** Update the runner session's `jobToken` and `userId` before each prompt. The MCP headers are built per run, so tools act as the person who posted. The bot itself is resolved with the bot owner's runner scope, because a shared bot's node belongs to its owner.
3. **The runner contract has no system prompt.** On a fresh runner session, send a rehydration preamble:
   - bot role
   - channel memory
   - for a thread: the root message
   - a few recent author-prefixed messages
   
   Later turns send `Speaker: message`. When a session idles out, the next fresh prompt rehydrates it instead of only warning that earlier messages are gone.
4. **Capacity is visible.** Each channel and thread is a runner session. Surface offline, at-capacity, and timeout errors in the channel or thread. Do not retry in a loop.

On the server the message log and memory are the source of truth. On a node the runner session holds live context; the server's log and memory are the recovery path.

## Access and security

- All bot channels are space-scoped: visible and postable by space members according to the bot's access level.
- In v1 there are no private user conversations: threads are space-visible. Private threads are a later extension for personal conversations.
- Each bot has an access level:
  - `editors` — space editors/owners
  - `members` — everyone in the space
- Defaults: internal bots `members`; node-backed bots `editors`, because a node runs commands on someone's machine.
- A node-backed bot in a shared channel is a deliberate trust decision by the node owner. Require the node to be explicitly shared with the space, and show a warning when creating the bot.
- Shared-channel turns get a scoped job token: document tools may only see documents that the whole space can view. This prevents a member's private document access from leaking into a shared reply through the bot.
- Channel creation, role editing, and deletion require at least editor; viewers can only post where the bot's access level allows.
- Bot ownership and lifecycle: a bot belongs to its creator. Transfer or deletion when its creator leaves is a follow-up.

## API

Evolve the existing session API rather than adding a bot API surface.

- `session/new` accepts `rolePrompt`, `avatar`, `parentSessionId`, `threadRootSeq`, `node`, `nodeAgent`. User-created sessions are space-scoped in v1; private threads are a later extension.
- `session/prompt`, `session/load`, `session/cancel` work for channels and threads, with access checks instead of `createdBy` ownership.
- Session listings return channels and (nested) threads only. Legacy private chats and job sessions are excluded.
- Message rows get list/append endpoints or ACP equivalents. The UI needs paging for long channels.
- Thread creation is a session create with a parent. A thread list is a query by `parentSessionId`.
- Agent schedules gain an optional target `sessionId`, so a recurring job can post into a bot channel instead of opening a new chat.

## UI

- No private chat list, no per-user session picker.
- Space sidebar: a Bots/Channels section. A channel opens a full timeline with member and bot avatars, composer, typing/streaming state, and node status.
- Empty state when a space has no channels; editors can create the first one.
- Bot editor: name, avatar, role prompt, run target (server or node), access level.
- Threads: "Reply in thread" on a message, reply count on the root, thread opens in a side pane. Threads do not appear in the main channel list.
- No memory UI; memory is entirely internal.
- The old floating assistant and session picker are removed; there is no fallback private chat surface.

## Migration and rollout

1. Rename `ai_chat_session` to `chat_session`, add the session columns, and add the `chat_message` table.
2. Backfill existing `messages` / `conversationHistory` into rows; keep the columns readable until all reads are switched, then deprecate and remove them.
3. Existing private chats stay in the database as hidden, creator-only legacy rows (`visibility: private`). They are not converted into channels and are not surfaced in the UI. Their transcripts are backfilled with everything else, so the JSON columns can still be removed.
4. Channels are the only AI surface. No channel is created automatically.

## Later

- Private threads, as the replacement for personal chats: a thread anchored to a channel message, visible only to its creator (and optionally invited participants). Not in v1. Deferred decisions: creator-only vs. participants, and whether a private thread reuses the parent channel's persona and node.
