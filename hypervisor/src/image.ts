import { chmod, copyFile, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { run } from "./process.ts";
import { stateDirectory } from "./state.ts";

export async function imageInfo(
  path: string,
): Promise<{ format: string; "virtual-size": number; "backing-filename"?: string }> {
  return JSON.parse(await run(["qemu-img", "info", "--output=json", path]));
}

export async function prepareImage(source?: string): Promise<string> {
  const directory = join(stateDirectory(), "images");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, "ubuntu.qcow2");
  if (await Bun.file(destination).exists()) return destination;
  const temporary = `${destination}.download`;
  try {
    await rm(temporary, { force: true });
    if (source) {
      const absolute = resolve(source);
      if (!(await stat(absolute)).isFile())
        throw new Error("--image must be a cloud image file.");
      const info = await imageInfo(absolute);
      if (info["backing-filename"])
        throw new Error("Base images must be standalone, without backing files.");
      await run(["qemu-img", "convert", "-O", "qcow2", absolute, temporary]);
    } else {
      const architecture = process.arch === "arm64" ? "arm64" : "amd64";
      const filename = `noble-server-cloudimg-${architecture}.img`;
      const base = "https://cloud-images.ubuntu.com/noble/current";
      const checksums = await fetch(`${base}/SHA256SUMS`);
      if (!checksums.ok)
        throw new Error(`Cannot download image checksums: ${checksums.status}`);
      const line = (await checksums.text())
        .split("\n")
        .find(
          (entry) => entry.endsWith(` ${filename}`) || entry.endsWith(` *${filename}`),
        );
      const expected = line?.slice(0, 64);
      if (!expected || !/^[a-f0-9]{64}$/.test(expected))
        throw new Error("Ubuntu image checksum not found.");
      process.stderr.write(`Downloading Ubuntu 24.04 ${architecture} cloud image...\n`);
      await run(
        [
          "curl",
          "--fail",
          "--location",
          "--retry",
          "3",
          "--output",
          temporary,
          `${base}/${filename}`,
        ],
        { stream: true },
      );
      const hash = new Bun.CryptoHasher("sha256");
      for await (const chunk of Bun.file(temporary).stream()) hash.update(chunk);
      if (hash.digest("hex") !== expected)
        throw new Error("Ubuntu image checksum mismatch; retry init.");
      if ((await imageInfo(temporary)).format !== "qcow2")
        throw new Error("Expected a qcow2 Ubuntu image.");
    }
    await chmod(temporary, 0o400);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  return destination;
}

export async function prepareFirmware(path?: string): Promise<string | undefined> {
  if (process.arch !== "arm64") return undefined;
  const destination = join(stateDirectory(), "images", "firmware.fd");
  // A previous init may have copied firmware before an image download failed.
  if (await Bun.file(destination).exists()) return destination;
  const candidates = path
    ? [resolve(path)]
    : [
        "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
        "/usr/local/share/qemu/edk2-aarch64-code.fd",
        "/usr/share/qemu/edk2-aarch64-code.fd",
        "/usr/share/AAVMF/AAVMF_CODE.fd",
        "/usr/share/edk2/aarch64/QEMU_EFI.fd",
      ];
  const source = await (async () => {
    for (const candidate of candidates)
      if (await Bun.file(candidate).exists()) return candidate;
    throw new Error("ARM UEFI firmware not found; supply --firmware <path>.");
  })();
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o400);
  return destination;
}

export async function seedImage(directory: string): Promise<void> {
  const destination = join(directory, "seed.iso");
  if (process.platform === "darwin") {
    await run([
      "hdiutil",
      "makehybrid",
      "-o",
      destination,
      "-iso",
      "-joliet",
      "-default-volume-name",
      "cidata",
      join(directory, "seed"),
    ]);
  } else {
    const tool = Bun.which("genisoimage") || Bun.which("mkisofs");
    if (!tool) throw new Error("Install genisoimage to create the cloud-init seed.");
    await run([
      tool,
      "-output",
      destination,
      "-volid",
      "cidata",
      "-joliet",
      "-rock",
      join(directory, "seed"),
    ]);
  }
  await chmod(destination, 0o600);
}
