import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
 *   <manager> stream <id>                    optional, the screen as H.264 and Opus
 *   <manager> input <id>                     optional, mouse and keyboard as JSON lines
 *
 * `run`'s stdio is the ACP pipe. A disposable environment lives as long as the
 * task's session and is stopped when it ends; `persistent` ones stay for the
 * next session. It reaches the Vektor server directly, with the task's job
 * token and never the node's own login.
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
  /** Reuse one named environment per bot across its channel and threads. */
  persistent: boolean;
  /** Variables set for the agent, e.g. an API key. */
  env: Record<string, string>;
  /** Files copied into the environment before the agent starts, e.g. its login. */
  files: Array<{ from: string; to: string }>;
  /** The agent started in the environment, e.g. `["opencode", "acp"]`. */
  inner: string[];
  /** The Vektor server the environment calls directly. */
  host: string;
  /** The session's directory inside the environment; default is the one `exec` starts in. */
  cwd?: string;
};

/** A chat's stable environment name, short enough to read in `vm ls`. */
function environmentName(name: string, spaceId: string, environmentId: string): string {
  const digest = createHash("sha256")
    .update(`${name}\0${spaceId}\0${environmentId}`)
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
function rememberEnvironment(
  name: string,
  init: { spaceId: string; environmentId?: string },
): void {
  const dir = environmentsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, name),
    `${JSON.stringify({ spaceId: init.spaceId, environmentId: init.environmentId })}\n`,
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

export function managedAdapter(options: ManagedOptions): Adapter {
  const { manager } = options;
  /** Starts for one persistent environment, in order, so two threads cannot create it at once. */
  const starts = new Map<string, Promise<string>>();

  function startEnvironment(name: string, init: { spaceId: string; environmentId?: string }) {
    const create = [...manager, "run", name, ...options.runArgs];
    const previous = starts.get(name);
    const next = (previous ? previous.catch(() => undefined) : Promise.resolve(undefined))
      .then(async () => {
        let id: string | undefined;
        if (!hasEnvironment(name)) {
          id = lastLine(await run(create));
        } else {
          try {
            id = lastLine(await run([...manager, "run", name, ...options.resumeArgs]));
          } catch (resumeError) {
            // It was deleted or its disk went away; create it again.
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
        rememberEnvironment(name, init);
        return id;
      });
    starts.set(name, next);
    void next
      .finally(() => {
        if (starts.get(name) === next) starts.delete(name);
      })
      .catch(() => {});
    return next;
  }

  return {
    async open(init) {
      const name =
        options.persistent && init.environmentId
          ? environmentName(options.name, init.spaceId, init.environmentId)
          : undefined;
      const id = name
        ? await startEnvironment(name, init)
        : lastLine(await run([...manager, "run", ...options.runArgs]));
      if (!id) throw new Error(`${manager[0]} run printed no environment id.`);
      const stop = () => run([...manager, "stop", id]).catch(() => {});

      try {
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
          VEKTOR_HOST: options.host,
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
            // The agent reads MCP servers from its own config; the node never
            // passes them over ACP, where they would override that config.
            mcp: null,
            // The environment is disposable, and its paths are not this node's.
            policy: { ...init.policy, workdir: cwd, autoApprove: true, readonly: false },
          },
        );
        return {
          ...session,
          screen: () => openScreen(manager, id),
          async close() {
            try {
              await session.close();
            } finally {
              // A persistent environment outlives its session; its manager may suspend it when idle.
              if (!name) await stop();
            }
          },
        };
      } catch (error) {
        // Keep a persistent environment for the next try; only a disposable one is cleaned up here.
        if (!name) await stop();
        throw error;
      }
    },
  };
}
