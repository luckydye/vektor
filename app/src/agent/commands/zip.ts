import { dirname, posix } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import { defineCommand } from "just-bash";

async function addPathToZip(
  files: Zippable,
  sourcePath: string,
  archivePath: string,
  fs: Parameters<typeof defineCommand>[1] extends (
    args: string[],
    ctx: infer Ctx,
  ) => Promise<unknown>
    ? Ctx["fs"]
    : never,
) {
  const stat = await fs.stat(sourcePath);
  if (stat.isDirectory) {
    const normalizedArchivePath = archivePath.endsWith("/")
      ? archivePath
      : `${archivePath}/`;
    files[normalizedArchivePath] = new Uint8Array(0);
    for (const entry of await fs.readdir(sourcePath)) {
      await addPathToZip(
        files,
        fs.resolvePath(sourcePath, entry),
        posix.join(archivePath, entry),
        fs,
      );
    }
    return;
  }

  files[archivePath] = Buffer.from(await fs.readFileBuffer(sourcePath));
}

export const zipCommand = defineCommand("zip", async (args, ctx) => {
  const filteredArgs = args.filter((arg) => !arg.startsWith("-"));
  if (filteredArgs.length < 2) {
    return {
      stdout: "",
      stderr: "usage: zip archive.zip <path...>\n",
      exitCode: 2,
    };
  }

  const [archiveArg, ...inputArgs] = filteredArgs;
  const archivePath = ctx.fs.resolvePath(ctx.cwd, archiveArg);
  const files: Zippable = {};

  for (const inputArg of inputArgs) {
    const inputPath = ctx.fs.resolvePath(ctx.cwd, inputArg);
    if (!(await ctx.fs.exists(inputPath))) {
      return {
        stdout: "",
        stderr: `zip: ${inputArg}: No such file or directory\n`,
        exitCode: 1,
      };
    }
    await addPathToZip(files, inputPath, posix.basename(inputArg), ctx.fs);
  }

  await ctx.fs.writeFile(archivePath, zipSync(files), "binary");
  return {
    stdout: `created ${archiveArg}\n`,
    stderr: "",
    exitCode: 0,
  };
});

export const zipinfoCommand = defineCommand("zipinfo", async (args, ctx) => {
  if (args.length === 0) {
    return { stdout: "", stderr: "usage: zipinfo archive.zip\n", exitCode: 2 };
  }
  const archivePath = ctx.fs.resolvePath(ctx.cwd, args[0]!);
  if (!(await ctx.fs.exists(archivePath))) {
    return {
      stdout: "",
      stderr: `zipinfo: ${args[0]}: No such file or directory\n`,
      exitCode: 1,
    };
  }
  const entries = unzipSync(Buffer.from(await ctx.fs.readFileBuffer(archivePath)));
  const lines = Object.entries(entries).map(([name, data]) => {
    const isDir = name.endsWith("/");
    return `${isDir ? "d" : "-"} ${data.length.toString().padStart(10)} ${name}`;
  });
  return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
});

export const unzipCommand = defineCommand("unzip", async (args, ctx) => {
  if (args.length === 0) {
    return {
      stdout: "",
      stderr: "usage: unzip archive.zip [-d destination]\n",
      exitCode: 2,
    };
  }

  const archiveArg = args[0];
  let destinationArg = ".";
  let list = false;
  for (let index = 1; index < args.length; index++) {
    const arg = args[index];
    if (arg === "-d") {
      destinationArg = args[index + 1] ?? ".";
      index++;
      continue;
    }
    if (arg === "-l") {
      list = true;
      continue;
    }
    return {
      stdout: "",
      stderr: `unzip: unsupported argument '${arg}'\n`,
      exitCode: 2,
    };
  }

  const archivePath = ctx.fs.resolvePath(ctx.cwd, archiveArg);
  if (!(await ctx.fs.exists(archivePath))) {
    return {
      stdout: "",
      stderr: `unzip: ${archiveArg}: No such file or directory\n`,
      exitCode: 1,
    };
  }

  const entries = unzipSync(Buffer.from(await ctx.fs.readFileBuffer(archivePath)));

  if (list) {
    const lines = Object.entries(entries).map(
      ([name, data]) => `${data.length.toString().padStart(10)} ${name}`,
    );
    return { stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 };
  }

  const destinationPath = ctx.fs.resolvePath(ctx.cwd, destinationArg);
  await ctx.fs.mkdir(destinationPath, { recursive: true });

  for (const [name, data] of Object.entries(entries)) {
    const outputPath = ctx.fs.resolvePath(destinationPath, name);
    if (name.endsWith("/")) {
      await ctx.fs.mkdir(outputPath, { recursive: true });
      continue;
    }
    await ctx.fs.mkdir(dirname(outputPath), { recursive: true });
    await ctx.fs.writeFile(outputPath, data, "binary");
  }

  return {
    stdout: `extracted ${archiveArg} to ${destinationArg}\n`,
    stderr: "",
    exitCode: 0,
  };
});
