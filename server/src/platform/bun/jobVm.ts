import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import {
  asBuffer,
  asRecord,
  checkPayloadSize,
  MAX_PAYLOAD_BYTES,
  toBytes,
} from "#jobs/runtime/capabilities.ts";
import { PRELUDE } from "#jobs/runtime/prelude.ts";
import type { CapabilityTable } from "#jobs/runtime/types.ts";
import type { VmEvent } from "#native/exec/index.d.ts";
import type { JobVm } from "#platform/platform.ts";
import { getNativeExec } from "./native.ts";

/** Wall-clock ceiling for one subprocess. */
const EXEC_TIMEOUT_MS = 5 * 60 * 1000;

/** True when an already-resolved path is the scratch root or sits under it. */
function isInside(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** A private directory per run, created on first use and removed at dispose. */
class Scratch {
  root: string | null = null;

  async dir(): Promise<string> {
    this.root ??= await mkdtemp(join(tmpdir(), "vektor-job-"));
    return this.root;
  }

  /** Resolve a guest-supplied path, refusing anything outside the scratch root. */
  async resolve(rawPath: unknown): Promise<string> {
    const root = await this.dir();
    const requested = String(rawPath ?? "");
    if (!requested || isAbsolute(requested)) {
      throw new Error(`scratch: "${requested}" must be a relative path`);
    }
    const resolved = normalize(join(root, requested));
    if (!isInside(root, resolved)) {
      throw new Error(`scratch: "${requested}" escapes the scratch directory`);
    }
    return resolved;
  }

  /**
   * Vet one `exec` argument. Allowlisting the binary keeps guest input from
   * becoming a command, but the converters take input and output paths, so an
   * unchecked argument would read or write anywhere the server process can —
   * every argument is treated as a candidate location and has to resolve inside
   * the scratch tree, which ordinary flags and values do unchanged.
   */
  async assertArgAllowed(cwd: string, arg: string): Promise<void> {
    const root = await this.dir();
    // Unwrapping only, and only ever narrowing: `--flag=value` and `@argfile`
    // hide a path one level in, and a flag's value may be a `:`-separated
    // search path. An argument that matches neither shape is checked whole,
    // which is the stricter reading, so a missed shape cannot pass a path.
    const flag = /^-{1,2}[^=]*=/.exec(arg);
    const candidates = flag
      ? arg.slice(flag[0].length).split(":")
      : [arg.replace(/^@/, "")];

    for (const candidate of candidates) {
      if (!candidate) continue;
      // Both decisions are a parser's, not a pattern's. A URL names a location
      // no path check would see — `file:///etc/passwd`, and gio and libreoffice
      // answer to schemes not worth enumerating — and the URL parser sees
      // through the tabs, newlines and leading spaces a pattern trips over. The
      // slash keeps CSS selectors out of it: `a:hover` parses as a URL, and
      // htmlq takes selectors as arguments.
      if (candidate.includes("/") && URL.canParse(candidate)) {
        throw new Error(`exec: argument "${arg}" names a URL, not a scratch path`);
      }
      if (isAbsolute(candidate) || !isInside(root, normalize(join(cwd, candidate)))) {
        throw new Error(`exec: argument "${arg}" points outside the scratch directory`);
      }
    }
  }

  async destroy(): Promise<void> {
    if (!this.root) return;
    const root = this.root;
    this.root = null;
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

function scratchCapabilities(
  scratch: Scratch,
  execAllowlist: ReadonlySet<string>,
  signal?: AbortSignal,
): CapabilityTable {
  return {
    // ── scratch filesystem ───────────────────────────────────────────────────
    scratchRead: (async (path: unknown) => {
      const file = await scratch.resolve(path);
      const info = await stat(file);
      checkPayloadSize(info.size, `scratch file ${String(path)}`);
      return toBytes(await readFile(file));
    }) as never,

    scratchReadText: (async (path: unknown) =>
      (await readFile(await scratch.resolve(path))).toString("utf8")) as never,

    scratchWrite: (async (path: unknown, content: unknown) => {
      const file = await scratch.resolve(path);
      const data = asBuffer(content);
      checkPayloadSize(data.byteLength, `scratch write to ${String(path)}`);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, data);
      return null;
    }) as never,

    scratchList: (async (dir: unknown) => {
      const target = dir ? await scratch.resolve(dir) : await scratch.dir();
      const entries = await readdir(target, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      }));
    }) as never,

    scratchRemove: (async (path: unknown) => {
      await rm(await scratch.resolve(path), { recursive: true, force: true });
      return null;
    }) as never,

    scratchMkdir: (async (path: unknown) => {
      await mkdir(await scratch.resolve(path), { recursive: true });
      return null;
    }) as never,

    // ── tools ────────────────────────────────────────────────────────────────
    /**
     * Run one of a fixed set of conversion tools. The command must be an
     * allowlisted name and no shell is involved, so guest input cannot become a
     * command; every argument is confined to the scratch tree, so it cannot
     * become a path to another tenant's data either.
     */
    exec: (async (rawCommand: unknown, rawArgs: unknown, rawOptions: unknown) => {
      const command = String(rawCommand ?? "");
      if (!execAllowlist.has(command)) {
        throw new Error(`exec: "${command}" is not an allowed tool`);
      }
      const args = (Array.isArray(rawArgs) ? rawArgs : []).map(String);
      const options = asRecord(rawOptions);
      const cwd = options.cwd ? await scratch.resolve(options.cwd) : await scratch.dir();
      for (const arg of args) await scratch.assertArgAllowed(cwd, arg);

      return await new Promise((resolve, reject) => {
        const child = execFile(
          command,
          args,
          {
            cwd,
            timeout: EXEC_TIMEOUT_MS,
            maxBuffer: MAX_PAYLOAD_BYTES,
            encoding: "buffer",
            signal,
            // No inherited environment: tools get a clean, minimal one.
            env: { PATH: process.env.PATH ?? "", HOME: cwd, LANG: "C.UTF-8" },
          },
          (error, stdout, stderr) => {
            const text = stderr.toString("utf8");
            if (error) {
              reject(new Error(`${command} failed: ${text || error.message}`));
              return;
            }
            resolve({ stdout: toBytes(stdout), stderr: text });
          },
        );
        if (options.stdin !== undefined && options.stdin !== null) {
          child.stdin?.end(asBuffer(options.stdin));
        }
      });
    }) as never,
  };
}

/**
 * The Boa VM from the native exec addon, with a private scratch directory per run.
 * Guest code runs on its own OS thread; this only translates its events into
 * capability calls and back, with no polling loop.
 */
export function createBoaJobVm(options: {
  /**
   * Binaries a job may run: fixed names, never a path and never guest-supplied,
   * so `exec` is a door to specific tools rather than to the shell.
   */
  execAllowlist: ReadonlySet<string>;
}): JobVm {
  return {
    run({ script, inputs, capabilities, onLog, timeoutMs, signal }) {
      let touch = () => {};
      const result = getNativeExec().then(
        (native) =>
          new Promise<unknown>((resolve, reject) => {
            let vmId: number | null = null;
            let settled = false;

            const finish = (outcome: () => void) => {
              if (settled) return;
              settled = true;
              signal?.removeEventListener("abort", onAbort);
              outcome();
            };

            const onAbort = () => {
              // The VM rejects in-flight calls and lets the script unwind, so the
              // terminal error event still arrives and settles this promise.
              if (vmId !== null) native.vmDestroy(vmId);
            };

            const onEvent = (event: VmEvent) => {
              switch (event.type) {
                case "log":
                  onLog(event.message ?? "");
                  // A guest log is observable proof of progress, so it renews the
                  // inactivity timeout even if the next host call takes a while.
                  if (vmId !== null) native.vmTouch(vmId);
                  return;

                case "call": {
                  const { callId, name } = event;
                  if (!callId || !name) return;
                  const capability = capabilities[name];
                  if (!capability) {
                    // Deny by default: a capability the host did not grant.
                    if (vmId !== null) {
                      native.vmReject(
                        vmId,
                        callId,
                        `"${name}" is not available in this job`,
                      );
                    }
                    return;
                  }
                  // Capabilities may be sync or async; normalize to a promise so a
                  // synchronous throw becomes a rejection in the guest too.
                  void (async () => {
                    try {
                      const args = (event.args ?? []) as never[];
                      const value = await capability(...args);
                      if (vmId !== null) native.vmResolve(vmId, callId, value ?? null);
                    } catch (error) {
                      const message =
                        error instanceof Error ? error.message : String(error);
                      if (vmId !== null) native.vmReject(vmId, callId, message);
                    }
                  })();
                  return;
                }

                case "done":
                  finish(() => resolve(event.output));
                  return;

                case "error":
                  finish(() => reject(new Error(event.message ?? "job failed")));
                  return;
              }
            };

            try {
              vmId = native.vmCreate(PRELUDE, script, inputs, { timeoutMs }, onEvent);
              touch = () => {
                if (vmId !== null && !settled) native.vmTouch(vmId);
              };
            } catch (error) {
              finish(() =>
                reject(error instanceof Error ? error : new Error(String(error))),
              );
              return;
            }

            // An abort that arrives before the VM is created still has to land.
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort, { once: true });
          }),
      );
      return { result, touch: () => touch() };
    },

    hostCapabilities(signal) {
      const scratch = new Scratch();
      return {
        table: scratchCapabilities(scratch, options.execAllowlist, signal),
        dispose: () => scratch.destroy(),
      };
    },
  };
}
