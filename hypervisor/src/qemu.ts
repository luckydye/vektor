import { createHash } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import { type RunOptions, run, shellQuote } from "./process.ts";
import {
  type Customer,
  capacityBytes,
  customerDirectory,
  type HostState,
  stateDirectory,
} from "./state.ts";

export function acceleration(
  platform = process.platform,
  arch = process.arch,
): { executable: string; accelerator: string; machine: string } {
  if (platform !== "darwin" && platform !== "linux")
    throw new Error("Supported hosts are macOS and Linux.");
  if (arch !== "arm64" && arch !== "x64")
    throw new Error("Supported host architectures are arm64 and x64.");
  return {
    executable: arch === "arm64" ? "qemu-system-aarch64" : "qemu-system-x86_64",
    accelerator: platform === "darwin" ? "hvf" : "kvm",
    machine: arch === "arm64" ? "virt,gic-version=3" : "q35",
  };
}

export function socketPath(customer: Customer): string {
  const hash = createHash("sha256")
    .update(`${stateDirectory()}/${customer.id}`)
    .digest("hex")
    .slice(0, 24);
  return `/tmp/vektor-host-${process.getuid?.() ?? "user"}/${hash}.sock`;
}

async function prepareSocketDirectory(): Promise<void> {
  const directory = `/tmp/vektor-host-${process.getuid?.() ?? "user"}`;
  await mkdir(directory, { mode: 0o700, recursive: true });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)
    throw new Error(`Unsafe QMP socket directory: ${directory}`);
}

function qemuPath(path: string): string {
  return path.replaceAll(",", ",,");
}

export function qemuArguments(
  state: HostState,
  customer: Customer,
  platform = process.platform,
): string[] {
  const driver = acceleration(platform, state.arch);
  const directory = customerDirectory(customer.name);
  const args = [
    driver.executable,
    "-name",
    `vektor-${customer.id}`,
    "-uuid",
    customer.id,
    "-machine",
    driver.machine,
    "-accel",
    driver.accelerator,
    "-cpu",
    "host",
    "-smp",
    String(customer.cpus),
    "-m",
    String(capacityBytes(customer.memory) / 1024 ** 2),
    "-display",
    "none",
    "-monitor",
    "none",
    "-serial",
    `file:${directory}/console.log`,
    "-qmp",
    `unix:${socketPath(customer)},server=on,wait=off`,
    "-pidfile",
    join(directory, "qemu.pid"),
    "-drive",
    `file=${qemuPath(join(directory, "root.qcow2"))},if=virtio,format=qcow2`,
    "-drive",
    `file=${qemuPath(join(directory, "data.qcow2"))},if=none,id=data,format=qcow2`,
    "-device",
    "virtio-blk-pci,drive=data,serial=vektor-data",
    "-drive",
    `file=${qemuPath(join(directory, "seed.iso"))},if=virtio,format=raw,readonly=on`,
    "-netdev",
    `user,id=net0,ipv6=off,restrict=${customer.network === "isolated" ? "on" : "off"},hostfwd=tcp:127.0.0.1:${customer.sshPort}-:22,hostfwd=tcp:127.0.0.1:${customer.httpPort}-:8080`,
    "-device",
    "virtio-net-pci,netdev=net0",
    "-daemonize",
  ];
  if (state.arch === "arm64") {
    if (!state.firmware)
      throw new Error("ARM64 requires UEFI firmware. Run init --firmware <path>.");
    args.push("-bios", state.firmware);
  }
  return args;
}

/** Negotiate QMP and verify identity before sending any lifecycle command. */
export function monitor<T>(customer: Customer, command: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(customer));
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("QMP timed out")), 5000);
    function finish(error?: Error, value?: T) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as T);
    }
    const send = (execute: string, id: string) =>
      socket.write(`${JSON.stringify({ execute, id })}\r\n`);
    socket.on("error", (error) => finish(error));
    socket.on("end", () => finish(new Error("QMP closed before replying")));
    socket.on("data", (data) => {
      buffer += data.toString();
      if (buffer.length > 1024 * 1024) return finish(new Error("Oversized QMP reply"));
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.error) return finish(new Error(`QMP: ${message.error.desc}`));
          if (message.QMP) send("qmp_capabilities", "capabilities");
          else if (message.id === "capabilities") send("query-name", "identity");
          else if (message.id === "identity") {
            if (message.return?.name !== `vektor-${customer.id}`)
              return finish(
                new Error("QMP VM identity mismatch; refusing to modify it."),
              );
            send(command, "command");
          } else if (message.id === "command") finish(undefined, message.return);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
}

export async function running(customer: Customer): Promise<boolean> {
  try {
    await monitor(customer, "query-status");
    return true;
  } catch (error) {
    if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code || ""))
      return false;
    throw error;
  }
}

export async function start(state: HostState, customer: Customer): Promise<void> {
  if (await running(customer)) return;
  await prepareSocketDirectory();
  await rm(socketPath(customer), { force: true });
  await run(qemuArguments(state, customer), { timeout: 30_000 });
  await monitor(customer, "query-status");
}

export async function stop(customer: Customer): Promise<void> {
  if (!(await running(customer))) return;
  await monitor(customer, "system_powerdown");
  const deadline = Date.now() + 120_000;
  let nextRequest = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await running(customer))) return;
    // Firmware/early boot can consume an ACPI event before the OS handles it.
    if (Date.now() >= nextRequest) {
      await monitor(customer, "system_powerdown");
      nextRequest = Date.now() + 10_000;
    }
    await Bun.sleep(500);
  }
  throw new Error("Guest did not shut down gracefully; it was not forcibly stopped.");
}

export function sshArguments(customer: Customer): string[] {
  const directory = customerDirectory(customer.name);
  return [
    "ssh",
    "-F",
    "/dev/null",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    `UserKnownHostsFile=${join(directory, "known_hosts")}`,
    "-o",
    "ConnectTimeout=5",
    "-o",
    "LogLevel=ERROR",
    "-i",
    join(directory, "id_ed25519"),
    "-p",
    String(customer.sshPort),
    "vektoradmin@127.0.0.1",
  ];
}

export function guestExec(
  customer: Customer,
  args: string[],
  options: RunOptions = {},
): Promise<string> {
  return run([...sshArguments(customer), args.map(shellQuote).join(" ")], options);
}

export async function guestPush(
  customer: Customer,
  path: string,
  input: string | Blob,
  mode: string,
): Promise<void> {
  await guestExec(
    customer,
    [
      "sudo",
      "sh",
      "-c",
      `umask 077; cat > ${shellQuote(path)} && chmod ${shellQuote(mode)} ${shellQuote(path)}`,
    ],
    { input },
  );
}

export async function waitForSSH(customer: Customer): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    if (!(await running(customer)))
      throw new Error(
        `VM exited during boot. Inspect ${customerDirectory(customer.name)}/console.log`,
      );
    try {
      await guestExec(customer, ["true"], { timeout: 10_000 });
      return;
    } catch {
      await Bun.sleep(1500);
    }
  }
  throw new Error(
    `SSH did not become ready. Inspect ${customerDirectory(customer.name)}/console.log`,
  );
}
