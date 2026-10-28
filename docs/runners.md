# Runners

A runner runs a space's extension jobs and workflow scripts outside the Vektor server, and, if it offers them, agents: sub-agents and chats. With the integrated runner off (`VEKTOR_INTEGRATED_RUNNER=0`), runners are the only place job code runs, so none of it runs in our environment.

There are two kinds, with one contract:

- **HTTP runners.** An endpoint a space owner adds under Space settings → AI → Runners. The server POSTs each request to it.
- **Nodes.** `vektor agent serve` on any device. The node dials in, so it needs no public address, and gets the same requests over its socket.

A run names a runner or node by name: `node` on `POST /api/v1/spaces/:spaceId/jobs/run` and `POST /api/v1/spaces/:spaceId/workflows/runs`, `vektor workflow run --node <name>`, or the picker next to "Run workflow". Without one it runs on the server, or on the least busy runner when the integrated runner is off. A workflow's `runJob` calls run on the workflow's runner.

## The contract

Every hop is a short request; no connection has to last as long as a run. The server POSTs a request with the runner's secret:

```http
POST <runner url>
Authorization: Bearer <the runner's secret, shown once when it was added>
Content-Type: application/json
```

A runner's URL is reachable by anyone, so it **must** refuse any request without exactly this header, before reading the body. The secret is the only thing that proves a request came from the Vektor instance.

The body's `kind` says what it is. A runner must handle `job`; the rest are optional:

| `kind` | What | The runner answers |
|---|---|---|
| `job` | run a job or workflow script | `202`, then runs it |
| `describe` | which agents it offers | `{ "agents": ["claude"] }`; any `4xx` means none |
| `agent` | one turn of an agent session | `202`, then runs it |
| `agent.close` | the session is over | `2xx` |

A `job` and an `agent` turn are runs. Each carries `runId` and `host`, and is done through calls:

```json
{
  "kind": "job",
  "runId": "…",
  "script": "…",
  "inputs": { … },
  "prelude": "…",
  "host": { "url": "https://vektor.example.com/api/v1/runs/<runId>/call", "token": "…" }
}
```

### Jobs

- **`script`** is the body of an async function: it may `await` and `return`, and reads its inputs as `input`.
- **Capabilities.** While the job runs, the runner calls capabilities (`readDocument`, `uploadArtifact`, `runJob`, …) by POSTing `{ "name": "readDocument", "args": ["doc_…"] }` to `host.url` with `Authorization: Bearer <host.token>`. The answer is `{ "value": … }` or `{ "error": "…" }`.
- **Logs** are the same call: `{ "name": "log", "args": ["a line"] }`.
- **The result** ends the job: `{ "name": "result", "args": [{ "output": <what the script returned> }] }`, or `[{ "error": "<message>" }]` when it failed.
- **Bytes** cross as `{ "__bytes": "<base64>" }`, in both directions.

### Every run

- **The result** call ends it. Only the first result counts, so a runner may retry it.
- **The token** dies with the run.
- **The deadline is the server's,** the same inactivity deadline a job has on the server: 15 minutes, renewed by every call. A run that works quietly for longer can call `touch` (no args) to stay alive. When the deadline passes, or the run is cancelled, the run fails and its calls are refused, which tells the runner to stop. A runner that crashes or goes away fails its runs the same way.

`prelude` does all of that for a JavaScript runner. It evaluates to `(host, extra) => (script, input) => Promise`: it builds the job's globals over the calls above, runs the script, encodes bytes, and reports the result (retrying it), resolving once the result is delivered. The guest's `fetch` and timers are the runtime's own.

## A runner in a few lines

```ts
export async function POST(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.VEKTOR_RUNNER_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  const job = await req.json();
  eval(job.prelude)(job.host)(job.script, job.inputs).catch(console.error);
  return new Response(null, { status: 202 });
}
```

This runs job code in the runner's own process, with whatever access that process has. Run it somewhere disposable, or swap `eval` for an isolate.

The job keeps running after the answer, so the process must outlive the request. On a serverless platform, hand the promise to its keep-alive (`ctx.waitUntil` on Cloudflare Workers) and mind its time limit.

## Agents

A runner that names agents when asked to `describe` runs them. The owner clicks Check on the runner after giving it its secret, and the server keeps the answer. Each turn of a session is one `agent` request:

```json
{
  "kind": "agent",
  "runId": "…",
  "sessionId": "…",
  "agent": "claude",
  "prompt": "…",
  "mcp": {
    "url": "https://vektor.example.com/api/mcp",
    "headers": { "X-Space-Id": "…", "X-Job-Token": "…", "X-Agent-Session": "…" }
  },
  "host": { "url": "…/api/v1/runs/<runId>/call", "token": "…" }
}
```

- **`sessionId`** stays the same across a chat's turns. A runner that keeps its agent session between turns keeps the conversation; one that starts fresh each turn simply has no memory of earlier ones. `agent.close` says the session is over.
- **`agent`** is one of the names `describe` returned.
- **`mcp`** is the Vektor tool surface as an MCP server over HTTP. Hand `url` and `headers` to the agent's MCP client. It acts as the session's user, with a short-lived token. Its `read_messages` and `send_message` tools carry messages between a sub-agent and its parent.
- **Updates** stream the agent's ACP `session/update` updates: `{ "name": "updates", "args": [[update, …]] }`. Send as many per call as have queued up.
- **The result** ends the turn: `{ "name": "result", "args": [{ "stopReason": "end_turn" }] }`, with `"cancelled"`, or `"error"` and an `error` message.

Agents on an HTTP runner are for the space's owners only. Nodes serve their own user's agents.

## Capabilities of your own

Pass them as `extra`; each becomes a global in the job:

```ts
eval(job.prelude)(job.host, {
  gpuInfo: async () => ({ name: "RTX 4090", memoryGb: 24 }),
  exec: (command: string, args: string[]) => runInSandbox(command, args),
})(job.script, job.inputs);
```

Nodes (`vektor agent serve`) offer the standard set only.

## What runs where

The server answers every capability that needs the space or Vektor itself:

- space operations and `getSecret`
- the job cache and `output`
- `runJob`, `agentPrompt`, `apiFetch` and `notifyInitiator`
- the compute helpers (`hash`, `hmac`, `zip`, `spreadsheet`, `image`) and `sleep`

It refuses `fetch`, the scratch directory and `exec`, so a runner's job never makes the server reach the network, disk or processes.

A runner brings those itself. The JS prelude uses the runtime's `fetch`. A node runs `fetch` (from its own network, without the server's private-address block), the scratch directory, `exec` with the allowlisted tools, the compute helpers and timers itself, in its job VM.

## Who may use which

- An HTTP runner runs jobs for the whole space, and agents for its owners.
- A node serves its own user's jobs and agents. With `--shared` it runs jobs for anyone in the space, including runs that have no user.

## Nodes

A node gets requests as `{ "type": "run", "request": … }` frames, and makes its runs' calls over HTTP like any runner, so a run carries on while the socket reconnects; like any runner's, a run whose node goes quiet fails on its deadline. Its `hello` names its agents and its session limit; `cancel` frames stop a run early. Screens, an agent session's live display, are a node's own extension: the node says `screen` when a session has one, and streams it on `screen.open`.
