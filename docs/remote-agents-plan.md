# Remote agents

Sub-agents and chats can run on other devices, and inside disposable VMs. A remote agent is self-sufficient: it brings its own model, tools and credentials, and can be any ACP-speaking agent (OpenCode, Claude via an adapter, the built-in Vektor loop) rather than only ours.

Agents run on runners, by the contract in [runners.md](runners.md): a node (`vektor agent serve`), or an HTTP runner that offers agents. This page covers what is particular to nodes.

## Nodes

```
vektor agent serve   (on any device, logged in)
  ├─ adapter: vektor    the server's own agent, over its ACP endpoint
  ├─ adapter: opencode  `opencode acp` as stdio subprocess
  ├─ adapter: <cmd>     any stdio ACP command
  └─ adapter: managed   create an environment through a CLI, run an adapter inside it
```

The node is a bridge, not an agent. It holds one outbound WebSocket (no inbound ports, works behind NAT), spawns the chosen agent as a stdio ACP subprocess with the Vektor MCP server (`vektor mcp`), and makes the run's calls to the server over HTTP.

## Managed environment adapter (see environment-manager-protocol.md)

`--manager <name>=<cli> --run-args <args> --inner "opencode acp"`, for any CLI implementing the environment manager protocol:

1. On a session's first `agent` request, create an environment (`<cli> create`).
2. Run `<inner agent> acp` in the VM; its stdio is the ACP pipe.
3. The VM lives as long as the session, so follow-up prompts and messages hit the same machine.
4. When the session closes, destroy the VM.

A VM needs the `vektor` binary (for the MCP server), a job token, and network reach to the Vektor server, proxied by the node. Artifacts leave the VM as space uploads or a git branch. `maxSessions` caps concurrent VMs. Because the VM is disposable, auto-approving permissions is safe there.

## Trust and security

- Each device gets its own revocable access token (device-code login), not the user's main token.
- A node runs agents only for its owner; with `--shared` it runs jobs for the whole space.
- Node policy flags: `--workdir` (confine files), `--readonly`, `--auto-approve`, and `--allow-shell` or a per-command confirm prompt. Default: confirm.
- The server never opens a connection to the device. Each session's agent gets a short-lived job token for its user.

## Open

- Schedules naming a runner, so "every morning, run X on the home server" works.
- Snapshots of a managed VM, so a session can resume; ephemeral only for now.
