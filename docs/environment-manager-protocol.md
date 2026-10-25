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

- Any non-zero exit from `run` fails the task with the CLI's stderr.
- The node calls `stop` when the task ends, fails or is cancelled, and when anything after `run` fails.
- The session's directory is `--env-workdir`, else the output of `exec <id> -- pwd`.

## What the environment must provide

- `env` and `pwd` on its PATH. The task's variables are set with `exec <id> -- env K=V... <agent command>`.
- The agent command (`--inner`, default `opencode acp`) and the `vektor` binary, whose `vektor mcp` gives the agent Vektor's tools and messaging.
- A network route to `<address>:<port>`, the node's proxy to the Vektor server. It forwards only `/api/v1/` and carries the task's short-lived job token, never the node's login.

## Policy

Environments are disposable, so the node auto-approves the agent's permission requests inside them and scopes paths to the session's directory.

## Example: varmint

```
vektor agent serve --manager vm=varmint --run-args "--mount .:work" --gateway <host-ip>
```
