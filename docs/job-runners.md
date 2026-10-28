# Job runners

A job runner runs a space's extension jobs and workflow scripts outside the Vektor server. With `VEKTOR_JOB_RUNTIME=node`, runners are the only place job code runs, so none of it runs in our environment.

There are two kinds, with one contract:

- **HTTP runners.** An endpoint a space owner adds under Space settings → AI → Job runners. The server POSTs each job to it.
- **Nodes.** `vektor agent serve` on any device. The node dials in, so it needs no public address, and gets the same request over its socket.

A run names a runner or node by name: `node` on `POST /api/v1/spaces/:spaceId/jobs/run` and `POST /api/v1/spaces/:spaceId/workflows/runs`, `vektor workflow run --node <name>`, or the picker next to "Run workflow". Without one it runs on the server, or on the least busy runner when `VEKTOR_JOB_RUNTIME=node`. A workflow's `runJob` calls run on the workflow's runner.

## The contract

Every hop is a short request; no connection has to last as long as the job. The server hands the job over:

```http
POST <runner url>
Authorization: Bearer <the runner's secret, shown once when it was added>
Content-Type: application/json

{
  "jobId": "…",
  "script": "…",
  "inputs": { … },
  "prelude": "…",
  "host": { "url": "https://vektor.example.com/api/v1/jobs/<jobId>/call", "token": "…" }
}
```

The runner accepts it with any `2xx` (`202 Accepted`) right away, and runs the job after answering.

- **`script`** is the body of an async function: it may `await` and `return`, and reads its inputs as `input`.
- **Capabilities.** While the job runs, the runner calls capabilities (`readDocument`, `uploadArtifact`, `runJob`, …) by POSTing `{ "name": "readDocument", "args": ["doc_…"] }` to `host.url` with `Authorization: Bearer <host.token>`. The answer is `{ "value": … }` or `{ "error": "…" }`.
- **Logs** are the same call: `{ "name": "log", "args": ["a line"] }`.
- **The result** ends the job: `{ "name": "result", "args": [{ "output": <what the script returned> }] }`, or `[{ "error": "<message>" }]` when it failed. Only the first result counts, so a runner may retry it.
- **Bytes** cross as `{ "__bytes": "<base64>" }`, in both directions.
- **The token** dies with the job.
- **The deadline is the server's,** the same inactivity deadline a job has on the server: 15 minutes, renewed by every call. A job that works quietly for longer can call `touch` (no args) to stay alive. When the deadline passes, or the run is cancelled, the job fails and its calls are refused, which tells the runner to stop. A runner that crashes or goes away fails its jobs the same way.

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

- An HTTP runner serves the whole space.
- A node serves its own user's runs. With `--shared` it serves anyone in the space, including runs that have no user.
