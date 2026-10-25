import { networkInterfaces } from "node:os";
import { openAcpSession, spawnTransport } from "./acpClient.ts";
import type { Adapter } from "./types.ts";

/**
 * Runs each task's agent in its own environment (a VM, a container, a remote
 * box) made by any CLI that implements the environment manager protocol,
 * documented in docs/environment-manager-protocol.md. The node only calls:
 *
 *   <manager> run [args...]                  prints the environment's id
 *   <manager> exec <id> -- <argv...>
 *   <manager> stop <id>
 *   <manager> address <id>                   optional
 *
 * `exec`'s stdio is the ACP pipe. The environment lives as long as the task's
 * session and is stopped when it ends. It reaches the Vektor server only
 * through this node's proxy, which carries the task's job token and never the
 * node's own login.
 */
export type ManagedOptions = {
  /** The manager command, e.g. `["varmint"]` or `["mgr", "--host", "box"]`. */
  manager: string[];
  /** Extra arguments for `run`, e.g. `["--mount", ".:work"]`. */
  runArgs: string[];
  /** The agent started in the environment, e.g. `["opencode", "acp"]`. */
  inner: string[];
  /** The Vektor server the proxy forwards to. */
  host: string;
  /** Where environments reach this node, when `address` is not offered. */
  gateway?: string;
  /** The session's directory inside the environment; default is the one `exec` starts in. */
  cwd?: string;
};

async function run(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(
      `${argv.slice(0, 2).join(" ")} failed (${code}): ${stderr.trim() || "no output"}`,
    );
  }
  return stdout.trim();
}

function localAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    const found = addresses?.find((a) => a.family === "IPv4" && !a.internal);
    if (found) return found.address;
  }
  return "127.0.0.1";
}

/** Forwards the API to the Vektor server for environments that cannot reach it directly. */
function startProxy(host: string) {
  const target = new URL(host);
  return Bun.serve({
    hostname: "0.0.0.0",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/v1/")) {
        return new Response("Not found", { status: 404 });
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      // The server checks the origin against its own.
      headers.set("Origin", target.origin);
      return fetch(`${target.origin}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.body,
      });
    },
  });
}

export function managedAdapter(options: ManagedOptions): Adapter {
  let proxy: ReturnType<typeof startProxy> | undefined;
  const { manager } = options;

  return {
    async open(init) {
      proxy ??= startProxy(options.host);
      // The id is the last line `run` prints, whatever it logged before.
      const id = (await run([...manager, "run", ...options.runArgs]))
        .split("\n")
        .at(-1)
        ?.trim();
      if (!id) throw new Error(`${manager[0]} run printed no environment id.`);
      const stop = () => run([...manager, "stop", id]).catch(() => {});

      try {
        // The protocol's optional `address`; a manager without it falls back to the node's own.
        const address =
          (await run([...manager, "address", id]).catch(() => "")) ||
          options.gateway ||
          localAddress();
        const cwd = options.cwd ?? (await run([...manager, "exec", id, "--", "pwd"]));
        const env = {
          VEKTOR_HOST: `http://${address}:${proxy.port}`,
          VEKTOR_SPACE_ID: init.spaceId,
          VEKTOR_JOB_TOKEN: init.jobToken,
          VEKTOR_TASK_ID: init.taskId,
        };
        const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
        const session = await openAcpSession(
          spawnTransport([
            ...manager,
            "exec",
            id,
            "--",
            "env",
            ...envArgs,
            ...options.inner,
          ]),
          {
            ...init,
            cwd,
            mcp: { command: "vektor", args: ["mcp"], env },
            // The environment is disposable, and its paths are not this node's.
            policy: { ...init.policy, workdir: cwd, autoApprove: true, readonly: false },
          },
        );
        return {
          ...session,
          async close() {
            await session.close();
            await stop();
          },
        };
      } catch (error) {
        await stop();
        throw error;
      }
    },
  };
}
