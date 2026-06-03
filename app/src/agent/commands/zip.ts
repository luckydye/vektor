import AdmZip from "adm-zip";
import { defineCommand } from "just-bash";
import { dirname, posix } from "node:path";

async function addPathToZip(
  zip: AdmZip,
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
    zip.addFile(normalizedArchivePath, Buffer.alloc(0));
    for (const entry of await fs.readdir(sourcePath)) {
      await addPathToZip(
        zip,
        fs.resolvePath(sourcePath, entry),
        posix.join(archivePath, entry),
        fs,
      );
    }
    return;
  }

  zip.addFile(archivePath, Buffer.from(await fs.readFileBuffer(sourcePath)));
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
  const zip = new AdmZip();

  for (const inputArg of inputArgs) {
    const inputPath = ctx.fs.resolvePath(ctx.cwd, inputArg);
    if (!(await ctx.fs.exists(inputPath))) {
      return {
        stdout: "",
        stderr: `zip: ${inputArg}: No such file or directory\n`,
        exitCode: 1,
      };
    }
    await addPathToZip(zip, inputPath, posix.basename(inputArg), ctx.fs);
  }

  await ctx.fs.writeFile(archivePath, new Uint8Array(zip.toBuffer()), "binary");
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
    return { stdout: "", stderr: `zipinfo: ${args[0]}: No such file or directory\n`, exitCode: 1 };
  }
  const zip = new AdmZip(Buffer.from(await ctx.fs.readFileBuffer(archivePath)));
  const lines = zip.getEntries().map((e) => {
    const size = e.header.size;
    const name = e.entryName;
    return `${e.isDirectory ? "d" : "-"} ${size.toString().padStart(10)} ${name}`;
  });
  return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
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

  const zip = new AdmZip(Buffer.from(await ctx.fs.readFileBuffer(archivePath)));

  if (list) {
    const lines = zip.getEntries().map((e) =>
      `${e.header.size.toString().padStart(10)} ${e.entryName}`
    );
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  }

  const destinationPath = ctx.fs.resolvePath(ctx.cwd, destinationArg);
  await ctx.fs.mkdir(destinationPath, { recursive: true });

  for (const entry of zip.getEntries()) {
    const outputPath = ctx.fs.resolvePath(destinationPath, entry.entryName);
    if (entry.isDirectory) {
      await ctx.fs.mkdir(outputPath, { recursive: true });
      continue;
    }
    await ctx.fs.mkdir(dirname(outputPath), { recursive: true });
    await ctx.fs.writeFile(outputPath, new Uint8Array(entry.getData()), "binary");
  }

  return {
    stdout: `extracted ${archiveArg} to ${destinationArg}\n`,
    stderr: "",
    exitCode: 0,
  };
});
