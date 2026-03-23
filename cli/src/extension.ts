import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { deflateRawSync } from "node:zlib";

// Default location for extensions, relative to cwd (i.e. the repo root).
const EXTENSIONS_DIR = "extensions/extensions";

// --- Zip utilities ---

interface ZipEntry {
  name: string;
  data: Buffer;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function createZipBuffer(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const centralDirectory: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf-8");
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    nameBuffer.copy(localHeader, 30);

    chunks.push(localHeader, compressed);

    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    nameBuffer.copy(centralHeader, 46);

    centralDirectory.push(centralHeader);
    offset += localHeader.length + compressed.length;
  }

  const centralDirBuffer = Buffer.concat(centralDirectory);
  const centralDirOffset = offset;

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirBuffer.length, 12);
  endRecord.writeUInt32LE(centralDirOffset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralDirBuffer, endRecord]);
}

// --- Helpers ---

function kebabToTitle(kebab: string): string {
  return kebab
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function validateExtensionId(id: string): void {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error("Extension ID must be lowercase alphanumeric with hyphens only");
  }
  if (id.startsWith("-") || id.endsWith("-")) {
    throw new Error("Extension ID cannot start or end with a hyphen");
  }
}

export function resolveExtension(extensionId: string | undefined): { id: string; dir: string } {
  if (extensionId) {
    validateExtensionId(extensionId);
    return { id: extensionId, dir: join(EXTENSIONS_DIR, extensionId) };
  }

  const cwd = process.cwd();
  const manifestPath = join(cwd, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(
      "No extension ID provided and current directory doesn't contain a manifest.json",
    );
  }
  const id = basename(cwd);
  validateExtensionId(id);
  return { id, dir: cwd };
}

// --- File templates for create ---

function createManifest(id: string, name: string): string {
  return JSON.stringify(
    {
      id,
      name,
      version: "1.0.0",
      description: `${name} extension`,
      entries: { frontend: "dist/main.js", view: "dist/view.js" },
      routes: [
        { path: id, title: name, menuItem: { title: name } },
      ],
    },
    null,
    2,
  );
}

function createViewTs(id: string, name: string): string {
  return `import type { ExtensionContext } from "../../../extension-api/types.ts";

export function activate(ctx: ExtensionContext): void {
  ctx.views.register("${id}", async (container) => {
    container.innerHTML = \`<div class="p-6"><h1 class="text-3xl font-bold">${name}</h1></div>\`;
  });
}

export function deactivate(ctx: ExtensionContext): void {
  ctx.views.unregister("${id}");
}
`;
}

function createPackageJson(id: string): string {
  return JSON.stringify(
    {
      name: `@wiki-ext/${id}`,
      version: "1.0.0",
      type: "module",
      scripts: {
        build: "bun build src/view.ts --outdir dist --format esm --target browser",
      },
    },
    null,
    2,
  );
}

// --- Commands ---

export function commandCreate(extensionId: string): void {
  validateExtensionId(extensionId);
  const extensionName = kebabToTitle(extensionId);
  const extensionDir = join(EXTENSIONS_DIR, extensionId);

  if (existsSync(extensionDir)) {
    throw new Error(`Extension '${extensionId}' already exists at ${extensionDir}`);
  }

  mkdirSync(join(extensionDir, "src"), { recursive: true });
  writeFileSync(join(extensionDir, "manifest.json"), createManifest(extensionId, extensionName));
  writeFileSync(join(extensionDir, "src", "view.ts"), createViewTs(extensionId, extensionName));
  writeFileSync(join(extensionDir, "package.json"), createPackageJson(extensionId));

  console.log(`Created ${extensionDir}`);
}

export async function commandPackage(extensionId: string | undefined): Promise<void> {
  const { id, dir: extensionDir } = resolveExtension(extensionId);

  if (!existsSync(extensionDir)) {
    throw new Error(`Extension '${id}' not found at ${extensionDir}`);
  }

  const manifestPath = join(extensionDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${extensionDir}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  const [major, minor, patch] = manifest.version.split(".").map(Number);
  manifest.version = `${major}.${minor}.${patch + 1}`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Version bumped to ${manifest.version}`);

  const distDir = join(extensionDir, "dist");
  if (existsSync(distDir)) rmSync(distDir, { recursive: true });

  const buildResult = Bun.spawnSync(["bun", "run", "build"], {
    cwd: extensionDir,
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (buildResult.exitCode !== 0) throw new Error("Build failed");

  const zipPath = join(extensionDir, `${id}.zip`);
  const zipEntries: ZipEntry[] = [
    { name: "manifest.json", data: readFileSync(manifestPath) },
  ];

  const scanDir = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const entryName = `${prefix}/${entry}`;
      if (statSync(fullPath).isDirectory()) scanDir(fullPath, entryName);
      else zipEntries.push({ name: entryName, data: readFileSync(fullPath) });
    }
  };

  if (existsSync(distDir)) scanDir(distDir, "dist");

  for (const entry of readdirSync(extensionDir)) {
    const fullPath = join(extensionDir, entry);
    if (
      entry === "manifest.json" ||
      entry === "dist" ||
      entry === "src" ||
      entry === "node_modules" ||
      entry === `${id}.zip` ||
      entry.startsWith(".")
    ) continue;
    if (statSync(fullPath).isFile()) {
      zipEntries.push({ name: entry, data: readFileSync(fullPath) });
    }
  }

  await Bun.write(zipPath, createZipBuffer(zipEntries));
  console.log(`Package created: ${zipPath}`);
}

export async function commandUpload(
  extensionId: string | undefined,
  wikiUrl: string,
  spaceId: string,
  token: string,
): Promise<void> {
  const { id, dir: extensionDir } = resolveExtension(extensionId);
  const zipPath = join(extensionDir, `${id}.zip`);

  if (!existsSync(zipPath)) {
    throw new Error(`Package not found at ${zipPath} — run 'extension package ${id}' first`);
  }

  const url = `${wikiUrl.replace(/\/$/, "")}/api/v1/spaces/${spaceId}/extensions`;
  console.log(`Uploading ${id}.zip to ${url}...`);

  const zipData = readFileSync(zipPath);
  const form = new FormData();
  form.append("file", new Blob([zipData], { type: "application/zip" }), `${id}.zip`);

  const origin = new URL(url).origin;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, Origin: origin },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Upload failed: ${response.status} ${response.statusText}${body ? `\n${body}` : ""}`);
  }

  const result = (await response.json()) as { id: string; name: string; version: string };
  console.log(`Uploaded: ${result.name} v${result.version} (${result.id})`);
}
