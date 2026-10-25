# Environment manager protocol

How a CLI lets `vektor agent serve` run agents in environments it manages (VMs, containers, remote boxes). The node is the only caller; the CLI needs nothing from Vektor. The verbs follow the shape of `docker` and `varmint`, so those work as they are.

```
vektor agent serve --manager <name>="<command...>" [--run-args "<args>"] [--inner "<agent command>"]
```

`<command...>` is the manager's command prefix, one or more words. The node adds the subcommands below; one adapter named `<name>` is offered to the server per `--manager`.

## Subcommands

| Call | Meaning | Contract |
|---|---|---|
| `<mgr> run [args...]` | Create and start an environment | Prints its id as the last line of stdout and exits 0 once `exec` works. `args` are whatever `--run-args` gave (image, mounts, …). |
| `<mgr> exec <id> -- <argv...>` | Run a command inside | stdin, stdout and stderr pass through unchanged (the ACP pipe: line-delimited JSON-RPC). Runs in the environment's default directory. Ends when the command ends or the process is killed. |
| `<mgr> stop <id>` | Dispose of the environment | The environment must not outlive it, so `run` has to make an ephemeral one. Idempotent; exit 0 if it is already gone. |
| `<mgr> address <id>` | *Optional.* Print the host the environment reaches the node at | One line on stdout. A non-zero exit means "not supported"; the node uses `--gateway`, else its own first non-loopback IPv4. |
| `<mgr> stream <id>` | *Optional.* Stream the environment's screen and sound | Writes the media below to stdout until it is killed. Run once per viewer, so each starts with a keyframe. A non-zero exit means "not supported" or failed; its stderr is shown to the viewer. |
| `<mgr> input <id>` | *Optional.* Drive the screen | Reads one JSON event per line from stdin until it closes. |

- Any non-zero exit from `run` fails the task with the CLI's stderr.
- The node calls `stop` when the task ends, fails or is cancelled, and when anything after `run` fails.
- The session's directory is `--env-workdir`, else the output of `exec <id> -- pwd`.

## Screen

The chat shows a managed task's screen and lets its user drive it. `stream` writes a sequence of messages, little-endian:

| Kind | Layout |
|---|---|
| Video | `0:u8` `width:u32` `height:u32` `keyframe:u8` `length:u32`, then `length` bytes of H.264 Annex B; a keyframe carries its SPS |
| Audio | `1:u8` `length:u32`, then `length` bytes of one Opus packet, 48 kHz stereo |

`input` takes these events, with pixel coordinates and Linux evdev codes:

```
{"move": {"x": 640, "y": 360}}
{"button": {"button": 272, "down": true}}     272 left, 273 right, 274 middle
{"key": {"code": 30, "down": true}}
{"scroll": {"value": -1, "horizontal": false}}
```

## What the environment must provide

- `env` and `pwd` on its PATH, plus `sh`, `mkdir`, `dirname` and `cat` when `--copy-file` is used. The task's variables are set with `exec <id> -- env K=V... <agent command>`.
- The agent command (`--inner`, default `opencode acp`) and the `vektor` binary, whose `vektor mcp` gives the agent Vektor's tools and messaging.
- A network route to `<address>:<port>`, the node's proxy to the Vektor server. It forwards only `/api/v1/` and carries the task's short-lived job token, never the node's login.

## Logins for the agent

The node's host is responsible for the agent's own login; the server never sends one. Two flags put it in the environment, both read on the node anew for each task, so a refreshed login is picked up:

- `--env NAME[=value]`: sets a variable for the agent. A bare `NAME` passes the node's own value, e.g. `--env ANTHROPIC_API_KEY`.
- `--copy-file <path>[:<path-in-env>]`: copies a file in before the agent starts, with mode 0600 (`~/` is the environment's home on the far side). E.g. `--copy-file ~/.codex/auth.json` for Codex's subscription login.

Both repeat. The values are the host's to choose and live only as long as the environment; note that `--env` values appear in the node's process list while `exec` runs, so prefer `--copy-file` for long-lived secrets.

## Policy

Environments are disposable, so the node auto-approves the agent's permission requests inside them and scopes paths to the session's directory.

## Example: varmint

```
vektor agent serve --manager vm=varmint --run-args "--mount .:work" --gateway <host-ip>
```
