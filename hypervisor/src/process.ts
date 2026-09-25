export interface RunOptions {
  input?: string | Blob;
  stream?: boolean;
  timeout?: number;
}

/** No host shell: arguments and binary stdin remain separate from commands. */
export async function run(command: string[], options: RunOptions = {}): Promise<string> {
  const child = Bun.spawn(command, {
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: options.stream ? "inherit" : "pipe",
    stderr: options.stream ? "inherit" : "pipe",
  });
  let timedOut = false;
  const milliseconds = options.timeout ?? 30 * 60_000;
  const timeout =
    milliseconds > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, milliseconds)
      : undefined;
  const stdout =
    child.stdout instanceof ReadableStream
      ? new Response(child.stdout).text()
      : Promise.resolve("");
  const stderr =
    child.stderr instanceof ReadableStream
      ? new Response(child.stderr).text()
      : Promise.resolve("");
  try {
    if (options.input !== undefined) {
      const sink = child.stdin as import("bun").FileSink;
      if (typeof options.input === "string") sink.write(options.input);
      else
        for await (const chunk of options.input.stream()) {
          sink.write(chunk);
          await sink.flush();
        }
      await sink.end();
    }
    const [output, errors, code] = await Promise.all([stdout, stderr, child.exited]);
    if (timedOut) throw new Error(`${command[0]} timed out.`);
    if (code !== 0)
      throw new Error(
        `${command[0]} failed (${code}): ${errors.trim() || "see command output"}`,
      );
    return output.trim();
  } catch (error) {
    child.kill("SIGKILL");
    await Promise.allSettled([stdout, stderr, child.exited]);
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
