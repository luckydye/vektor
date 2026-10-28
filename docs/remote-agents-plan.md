# Remote agents

Run sub-agents on other devices, and inside disposable VMs, from the Vektor server. A remote agent is self-sufficient: it brings its own model, tools and credentials, and can be any ACP-speaking agent (OpenCode, Claude via an adapter, the built-in Vektor loop) rather than only ours.

## Where we are

- The agent loop runs on the server in a Bun worker (`server/src/agent`). `runAgentPrompt` is the loop; its shell is an in-memory sandbox.
- The server speaks an ACP-style JSON-RPC protocol at `/api/v1/chat/acp` (`session/new`, `session/prompt`, `session/update`, `session/cancel`).
- Sub-agents (`agent/subagents.ts`): `start_subagent`, `list_subagents`, `wait_subagents`, `cancel_subagent`, `send_message`. They run in-process; the hub's `run(task, signal, link)` callback is the single place a run starts.
- The CLI has `vektor login` (host + access token), `vektor agent` (ACP client) and a stdio MCP server (`cli/mcp.ts`) over the Vektor tool surface.
- Scheduled prompts exist as `workflow_schedule` rows with a `prompt`.

## Model

```
Vektor server
  ├─ node registry (per user, online/offline, capabilities)
  └─ sub-agent hub ── start_subagent({ task, node?, agent? })
        │  WebSocket frames (outbound from the node)
        ▼
vektor agent serve   (on any device, logged in)
  ├─ adapter: vektor    built-in loop, run locally
  ├─ adapter: opencode  `opencode acp` as stdio subprocess
  ├─ adapter: claude    ACP adapter subprocess
  ├─ adapter: <cmd>     any stdio ACP command
  └─ adapter: managed   create an environment through a CLI, run an adapter inside it
```

The node is a bridge, not an agent. It holds one outbound WebSocket (no inbound ports, works behind NAT), spawns the chosen agent as a stdio ACP subprocess, and relays JSON-RPC frames both ways.

## Protocol

JSON frames over the WebSocket, wrapping ACP messages:

| Frame | Direction | Purpose |
|---|---|---|
| `hello` | node → server | name, OS, workdir, adapters, `maxSessions` |
| `session.new` / `session.prompt` / `session.cancel` | server → node | ACP requests, with a server-chosen `taskId` |
| `session.close` | server → node | ends the session; a chat's stays open between prompts until then |
| `session.update` / `session.result` | node → server | ACP `session/update` notifications and the final `stopReason` |
| `message` | both | `send_message` between the parent and the sub-agent |
| `ping` | both | heartbeat; the server marks a node offline after missed beats |

A reconnecting node re-announces its running sessions; the server resumes streaming them or fails the ones that died.

## Vektor tools and messaging for foreign agents

`cli/mcp.ts` is passed in `mcpServers` on `session/new`, authenticated with a short-lived job token for the task's user. Foreign agents then get the Vektor tool surface. Add two MCP tools, `send_message` and `read_messages`, backed by the server hub, so parent ↔ sub-agent and sub-agent ↔ sub-agent messaging works for any adapter. Cancel maps to `session/cancel`.

## Managed environment adapter (see environment-manager-protocol.md)

`--manager <name>=<cli> --run-args <args> --inner "opencode acp"`, for any CLI implementing the environment manager protocol:

1. On `session.new`, create an environment (`<cli> create`).
2. Run `<inner agent> acp` in the VM; its stdio is the ACP pipe.
3. Relay frames as for any adapter. The VM lives as long as the session, so follow-up prompts and messages hit the same machine.
4. On cancel or completion, destroy the VM, or snapshot it when the task asks to keep it.

A VM needs the `vektor` binary (for the MCP server), a job token, and network reach to the Vektor server (direct, or proxied by the bridge). Artifacts leave the VM as space uploads or a git branch. `maxSessions` caps concurrent VMs.

Because the VM is disposable, auto-approving permissions is safe there.

## Jobs and workflows on nodes

Extension jobs and workflow scripts can run on a node instead of the server. The goal for the hosted version is that no job code runs in our environment: `VEKTOR_JOB_RUNTIME=node` turns the server's job VM off, and every run goes to a node.

- **Choosing.** A run names a node (`node` on `POST /jobs/run` and `POST /workflows/runs`, `vektor workflow run --node`, the picker next to "Run workflow"). Without one, it runs on the server, or on the least busy node it may use when `VEKTOR_JOB_RUNTIME=node`. A workflow's `runJob` calls run on the workflow's node.
- **Which nodes.** The run's user's own nodes, plus nodes started with `vektor agent serve --shared`, which run jobs for anyone in the space, including runs with no user. Agents and chats still use only their user's own nodes.
- **Frames.** `job.run`, `job.touch` and `job.cancel` go to the node; `job.log` and `job.result` come back.
- **Capabilities.** The node runs the job in its own boa VM. It handles `fetch` (from its own network, without the server's egress denylist), `sleep`, the compute helpers (`hash`, `hmac`, zip, spreadsheets), the scratch directory and `exec`. Everything else (space operations, cache, `output`, `getSecret`, `agentPrompt`, images, `runJob`) is a `job.call` the server answers with `job.reply`, from the same table a local run gets, minus what the node runs. So the server never fetches or runs a tool for a node's job, and the node never holds a token for the space.
- **Disconnects.** A node that drops fails its jobs at once, on both sides; a job's calls cannot wait for a reconnect.

## Trust and security

- Each device gets its own revocable access token (device-code login), not the user's main token.
- A node is usable only by agents running as its owner. Nodes belong to a user (open: or to a space).
- Node policy flags: `--workdir` (confine files), `--readonly`, `--auto-approve`, and `--allow-shell` or a per-command confirm prompt. Default: confirm.
- Remote agents' `session/request_permission` is forwarded to the parent agent and the user unless policy answers it.
- The server never opens a connection to the device. Each task gets a short-lived job token.

## Phases

1. **Transport and registry.** WebSocket endpoint, node registry, device token, `vektor agent serve` with heartbeat and reconnect, `list_nodes` tool. No adapter yet beyond echo.
2. **Hub integration.** `start_subagent` gets `node` and `agent`. The hub's `run` sends `session.*` frames and maps `session.update` to events and the final result. Cancel and `send_message` over frames.
3. **Adapters.** `vektor` (local `runAgentPrompt`), then `opencode`, then a generic `<cmd>` adapter, then Claude once its ACP route is confirmed.
4. **MCP for foreign agents.** Pass `cli/mcp.ts` in `mcpServers`; add `send_message` and `read_messages` MCP tools.
5. **Managed adapter.** Boot, exec, relay, destroy; image selection; `maxSessions`.
6. **Triggers.** Schedules and chat can name a node (and adapter), so "every morning, run X on the home server" works.
7. **Jobs.** Jobs and workflow scripts run on nodes; `VEKTOR_JOB_RUNTIME=node` makes nodes the only place they run. Open: schedules naming a node.

## Open questions

- varmint's interface: CLI, socket or API for boot, exec and destroy?
  -> cli
- Ephemeral VMs only, or snapshots so a session can resume?
  -> Ephemeral only for now
- VM → Vektor server: direct network, or proxied by the bridge?
  -> proxied by the vektor cli
- Do nodes belong to a user or to a space?
  -> whatever is simpler
