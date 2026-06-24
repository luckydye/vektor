import { posix } from "node:path";
import { defineCommand } from "just-bash";
import { extractManifest } from "../../utils/extensionManifest.ts";
import { installExtension, type VektorMcpConfig } from "../../utils/vektorMcp.ts";

const USAGE = "usage: extension install <zip-file> | extension init <name>\n";

async function handleInstall(
  args: string[],
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1],
  mcpConfig: VektorMcpConfig,
): ReturnType<Parameters<typeof defineCommand>[1]> {
  const [fileArg] = args;
  if (!fileArg) {
    return { stdout: "", stderr: USAGE, exitCode: 2 };
  }

  const filePath = ctx.fs.resolvePath(ctx.cwd, fileArg);
  if (!(await ctx.fs.exists(filePath))) {
    return {
      stdout: "",
      stderr: `extension: ${fileArg}: No such file or directory\n`,
      exitCode: 1,
    };
  }

  const bytes = await ctx.fs.readFileBuffer(filePath);
  const zipBuffer = Buffer.from(bytes);

  try {
    extractManifest(zipBuffer);
  } catch (err) {
    return {
      stdout: "",
      stderr: `extension install: invalid package: ${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 1,
    };
  }

  const content = zipBuffer.toString("base64");
  const filename = posix.basename(filePath);

  const result = await installExtension(mcpConfig, {
    filename,
    contentBase64: content,
  });

  return {
    stdout: `${typeof result === "string" ? result : JSON.stringify(result, null, 2)}\n`,
    stderr: "",
    exitCode: 0,
  };
}

async function handleInit(
  args: string[],
  ctx: Parameters<Parameters<typeof defineCommand>[1]>[1],
): ReturnType<Parameters<typeof defineCommand>[1]> {
  const [nameArg] = args;
  if (!nameArg) {
    return { stdout: "", stderr: USAGE, exitCode: 2 };
  }

  // Validate: lowercase alphanumeric + hyphens only
  if (!/^[a-z0-9-]+$/.test(nameArg)) {
    return {
      stdout: "",
      stderr: `extension init: name must be lowercase alphanumeric and hyphens only\n`,
      exitCode: 1,
    };
  }

  const dir = ctx.fs.resolvePath(ctx.cwd, nameArg);
  const distDir = posix.join(dir, "dist");

  const manifest = {
    id: nameArg,
    name: nameArg
      .split("-")
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" "),
    version: "1.0.0",
    description: "",
    entries: {
      frontend: "dist/main.js",
    },
  };

  const mainJs = `export function activate(ctx) {
  ctx.actions.register('${nameArg}.hello', {
    title: 'Hello from ${manifest.name}',
    run: async () => {
      alert('Hello from ${manifest.name}!');
    },
  });
}

export function deactivate(ctx) {
  ctx.actions.unregister('${nameArg}.hello');
}
`;

  await ctx.fs.mkdir(distDir, { recursive: true });
  await ctx.fs.writeFile(
    posix.join(dir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  await ctx.fs.writeFile(posix.join(distDir, "main.js"), mainJs, "utf8");

  return {
    stdout: `Created ${nameArg}/manifest.json\nCreated ${nameArg}/dist/main.js\n`,
    stderr: "",
    exitCode: 0,
  };
}

export function extensionCommand(mcpConfigRef: { current: VektorMcpConfig }) {
  return defineCommand("extension", async (args, ctx) => {
    const [subcommand, ...rest] = args;

    if (subcommand === "install") {
      return handleInstall(rest, ctx, mcpConfigRef.current);
    }
    if (subcommand === "init") {
      return handleInit(rest, ctx);
    }
    return { stdout: "", stderr: USAGE, exitCode: 2 };
  });
}
