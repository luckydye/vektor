import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { openAcpSession, spawnTransport } from "./acpClient.ts";
import type { Adapter, ScreenSession } from "./types.ts";

/**
 * Runs each task's agent in its own environment (a VM, a container, a remote
 * box) made by any CLI that implements the environment manager protocol,
 * documented in docs/environment-manager-protocol.md. The node only calls:
 *
 *   <manager> run [args...]                  prints the environment's id
 *   <manager> run <id> -- <argv...>
 *   <manager> stop <id>
 *   <manager> address <id>                   optional
 *   <manager> stream <id>                    optional, the screen as H.264 and Opus
 *   <manager> input <id>                     optional, mouse and keyboard as JSON lines
 *
 * `run`'s stdio is the ACP pipe. The environment lives as long as the task's
 * session and is stopped when it ends. It reaches the Vektor server only
 * through this node's proxy, which carries the task's job token and never the
 * node's own login.
 */
export type ManagedOptions = {
  /** The adapter name, so two managers do not share an environment. */
  name: string;
  /** The manager command, e.g. `["vm"]` or `["mgr", "--host", "box"]`. */
  manager: string[];
  /** Extra arguments for `run`, e.g. `["--mount", ".:work"]`. */
  runArgs: string[];
  /** Arguments for starting an environment that already exists; the first run's create-only flags fail on it. */
  resumeArgs: string[];
  /** Reuse one named environment per chat across sessions. */
  persistent: boolean;
  /** Variables set for the agent, e.g. an API key. */
  env: Record<string, string>;
  /** Files copied into the environment before the agent starts, e.g. its login. */
  files: Array<{ from: string; to: string }>;
  /** The agent started in the environment, e.g. `["opencode", "acp"]`. */
  inner: string[];
  /** The Vektor server the proxy forwards to. */
  host: string;
  /** Where environments reach this node, when `address` is not offered. */
  gateway?: string;
  /** The session's directory inside the environment; default is the one `exec` starts in. */
  cwd?: string;
};

/** A chat's stable environment name, short enough to read in `vm ls`. */
function environmentName(name: string, spaceId: string, chatId: string): string {
  const digest = createHash("sha256")
    .update(`${name}\0${spaceId}\0${chatId}`)
    .digest("hex");
  return `vektor-${digest.slice(0, 16)}`;
}

function environmentsDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "vektor", "environments");
}

function hasEnvironment(name: string): boolean {
  return existsSync(join(environmentsDir(), name));
}

/** Remembers that `name` was created, so its create-only flags are not retried on every start. */
function rememberEnvironment(name: string, init: { spaceId: string; chatId?: string }): void {
  const dir = environmentsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, name),
    `${JSON.stringify({ spaceId: init.spaceId, chatId: init.chatId })}\n`,
    { mode: 0o600 },
  );
}

function lastLine(output: string): string | undefined {
  return output.split("\n").at(-1)?.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function run(argv: string[], stdin?: string): Promise<string> {
  const proc = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
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

/** One viewer's `stream` and, once it sends input, `input` process. */
function openScreen(manager: string[], id: string): ScreenSession {
  const stream = Bun.spawn([...manager, "stream", id], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  let input: Bun.Subprocess<"pipe", "ignore", "ignore"> | undefined;
  let closed = false;
  const ended = (async () => {
    const [stderr, code] = await Promise.all([
      new Response(stream.stderr).text(),
      stream.exited,
    ]);
    if (code !== 0 && !closed) {
      throw new Error(
        `${manager[0]} stream failed (${code}): ${stderr.trim() || "no output"}`,
      );
    }
  })();
  return {
    media: stream.stdout,
    ended,
    input(events) {
      input ??= Bun.spawn([...manager, "input", id], {
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
      });
      for (const event of events) input.stdin.write(`${JSON.stringify(event)}\n`);
      void input.stdin.flush();
    },
    close() {
      closed = true;
      stream.kill();
      input?.kill();
    },
  };
}

/** Writes stdin to `$1`, a path in the environment where `~/` is its home. */
const WRITE_FILE =
  'p=$1; case "$p" in "~/"*) p="$HOME/${p#"~/"}";; esac; umask 077; mkdir -p "$(dirname "$p")" && cat > "$p"';

const localPath = (path: string) =>
  path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;

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
      const name =
        options.persistent && init.chatId
          ? environmentName(options.name, init.spaceId, init.chatId)
          : undefined;
      const create = [...manager, "run", ...(name ? [name] : []), ...options.runArgs];
      let id: string | undefined;
      if (!name) {
        id = lastLine(await run(create));
      } else if (!hasEnvironment(name)) {
        id = lastLine(await run(create));
      } else {
        try {
          id = lastLine(await run([...manager, "run", name, ...options.resumeArgs]));
        } catch (resumeError) {
          // The VM was deleted or its disk went away; create it again.
          try {
            id = lastLine(await run(create));
          } catch (createError) {
            throw new Error(
              `${errorMessage(createError)} (could not resume ${name}: ${errorMessage(resumeError)})`,
            );
          }
        }
      }
      if (!id) throw new Error(`${manager[0]} run printed no environment id.`);
      const stop = () => run([...manager, "stop", id]).catch(() => {});

      try {
        if (name) rememberEnvironment(name, init);
        // The protocol's optional `address`; a manager without it falls back to the node's own.
        const address =
          (await run([...manager, "address", id]).catch(() => "")) ||
          options.gateway ||
          localAddress();
        // The agents' own logins are the node host's to supply, and are read
        // anew for each task so a refreshed login is picked up.
        for (const file of options.files) {
          const source = Bun.file(localPath(file.from));
          if (!(await source.exists()))
            throw new Error(`--copy-file: ${file.from} does not exist.`);
          await run(
            [...manager, "run", id, "--", "sh", "-c", WRITE_FILE, "sh", file.to],
            await source.text(),
          );
        }
        const cwd = options.cwd ?? (await run([...manager, "run", id, "--", "pwd"]));
        const env = {
          ...options.env,
          VEKTOR_HOST: `http://${address}:${proxy.port}`,
          VEKTOR_SPACE_ID: init.spaceId,
          VEKTOR_JOB_TOKEN: init.jobToken,
        };
        const envArgs = Object.entries(env).map(([key, value]) => `${key}=${value}`);
        const session = await openAcpSession(
          spawnTransport([
            ...manager,
            "run",
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
          screen: () => openScreen(manager, id),
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
