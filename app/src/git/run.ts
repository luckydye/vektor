/** Running git as a subprocess: the one place that knows where the binary is. */

import { appLogger } from "#observability/logger.ts";

let execPath: string | null = null;

/**
 * Git's libexec directory, which is where `git-http-backend` lives. Asked of
 * git itself rather than guessed: it differs between distributions, Homebrew
 * and the Xcode command line tools.
 */
export async function gitExecPath(): Promise<string> {
  if (execPath) return execPath;
  const proc = Bun.spawn(["git", "--exec-path"], { stdout: "pipe", stderr: "ignore" });
  const output = (await new Response(proc.stdout).text()).trim();
  if ((await proc.exited) !== 0 || !output) {
    throw new Error("Could not locate git");
  }
  execPath = output;
  return execPath;
}

/**
 * Run git in `dir`, returning stdout as bytes.
 *
 * Separate from {@link git} because that one decodes as UTF-8, which mangles
 * anything that is not text — an image read back through it is corrupt.
 */
export async function gitBytes(dir: string, args: string[]): Promise<Buffer | null> {
  const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [bytes, code] = await Promise.all([
    new Response(proc.stdout).arrayBuffer(),
    proc.exited,
  ]);
  return code === 0 ? Buffer.from(bytes) : null;
}

/** Run git in `dir`, returning stdout. Throws with stderr on a non-zero exit. */
export async function git(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    appLogger.error("git command failed", { dir, args, code, stderr });
    throw new Error(`git ${args[0]} failed: ${stderr.trim()}`);
  }
  return stdout;
}
