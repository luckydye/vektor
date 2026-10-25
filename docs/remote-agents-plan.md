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
  └─ adapter: varmint   boot a VM, run an adapter inside it
```

The node is a bridge, not an agent. It holds one outbound WebSocket (no inbound ports, works behind NAT), spawns the chosen agent as a stdio ACP subprocess, and relays JSON-RPC frames both ways.

## Protocol

JSON frames over the WebSocket, wrapping ACP messages:

| Frame | Direction | Purpose |
|---|---|---|
| `hello` | node → server | name, OS, workdir, adapters, `maxSessions` |
| `session.new` / `session.prompt` / `session.cancel` | server → node | ACP requests, with a server-chosen `taskId` |
| `session.update` / `session.result` | node → server | ACP `session/update` notifications and the final `stopReason` |
| `message` | both | `send_message` between the parent and the sub-agent |
| `ping` | both | heartbeat; the server marks a node offline after missed beats |

A reconnecting node re-announces its running sessions; the server resumes streaming them or fails the ones that died.

## Vektor tools and messaging for foreign agents

`cli/mcp.ts` is passed in `mcpServers` on `session/new`, authenticated with a short-lived job token for the task's user. Foreign agents then get the Vektor tool surface. Add two MCP tools, `send_message` and `read_messages`, backed by the server hub, so parent ↔ sub-agent and sub-agent ↔ sub-agent messaging works for any adapter. Cancel maps to `session/cancel`.

## Varmint VM adapter

`--agent varmint --image <name> --inner opencode`:

1. On `session.new`, boot a VM (`varmint` CLI, interface to confirm).
2. Run `<inner agent> acp` in the VM; its stdio is the ACP pipe.
3. Relay frames as for any adapter. The VM lives as long as the session, so follow-up prompts and messages hit the same machine.
4. On cancel or completion, destroy the VM, or snapshot it when the task asks to keep it.

A VM needs the `vektor` binary (for the MCP server), a job token, and network reach to the Vektor server (direct, or proxied by the bridge). Artifacts leave the VM as space uploads or a git branch. `maxSessions` caps concurrent VMs.

Because the VM is disposable, auto-approving permissions is safe there.

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
5. **Varmint adapter.** Boot, exec, relay, destroy; image selection; `maxSessions`.
6. **Triggers.** Schedules and chat can name a node (and adapter), so "every morning, run X on the home server" works.

## Open questions

- varmint's interface: CLI, socket or API for boot, exec and destroy?
  -> cli
- Ephemeral VMs only, or snapshots so a session can resume?
  -> Ephemeral only for now
- VM → Vektor server: direct network, or proxied by the bridge?
  -> proxied by the vektor cli
- Do nodes belong to a user or to a space?
  -> whatever is simpler
