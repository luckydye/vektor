#!/usr/bin/env bun
import { parseArgs } from "node:util";
import {
  backup,
  caddyConfig,
  changePower,
  create,
  initialize,
  list,
  remove,
  update,
} from "./host.ts";
import { run } from "./process.ts";
import { acceleration, guestExec } from "./qemu.ts";
import { customerDirectory, getCustomer, readState, withLock } from "./state.ts";

const help = `Usage: vektor-host <command> [options]

Direct QEMU VMs: Hypervisor.framework on macOS, KVM on Linux.
VM architecture matches the host. No Incus, containers, or nested VMs.

  init [--image <ubuntu-cloud.qcow2>] [--firmware <arm-uefi.fd>]
  create <name> [--cpus 2] [--memory 2GiB] [--disk 20GiB]
         [--network nat|isolated]
         [--binary <linux-binary> --domain <hostname> --env <env.json>]
  list
  status <name>
  start|stop|restart <name>
  exec <name> -- <command> [args...]
  logs <name> [--follow] [--console]
  backup <name> [--backup-dir <directory>]
  update <name> --binary <linux-binary> [--backup-dir <directory>]
  remove <name>
  caddy

init downloads a checksum-verified Ubuntu 24.04 cloud image by default.
create without --binary creates a plain Linux VM with SSH access.
NAT permits outbound networking; isolated blocks outbound host/internet access.
SSH and app ports bind only to 127.0.0.1; list shows their allocated ports.
remove retains the separate data disk and credentials.
All commands accept --state-dir (default ~/.local/share/vektor-host).
`;
const string = { type: "string" } as const;
const boolean = { type: "boolean" } as const;
const options = {
  init: { image: string, firmware: string },
  create: {
    binary: string,
    domain: string,
    env: string,
    cpus: string,
    memory: string,
    disk: string,
    network: string,
  },
  list: {},
  status: {},
  start: {},
  stop: {},
  restart: {},
  exec: {},
  logs: { follow: boolean, console: boolean },
  backup: { "backup-dir": string },
  update: { binary: string, "backup-dir": string },
  remove: {},
  caddy: {},
};
const print = (value: unknown) =>
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

export async function main(argv: string[]): Promise<void> {
  const command = argv[0];
  if (!command || ["help", "--help", "-h"].includes(command)) {
    process.stdout.write(help);
    return;
  }
  if (!Object.hasOwn(options, command)) throw new Error(`Unknown command: ${command}`);
  const split = argv.indexOf("--");
  const guestCommand = command === "exec" && split !== -1 ? argv.slice(split + 1) : [];
  const { values, positionals } = parseArgs({
    args: argv.slice(1, command === "exec" && split !== -1 ? split : undefined),
    allowPositionals: true,
    strict: true,
    options: {
      ...options[command as keyof typeof options],
      "state-dir": string,
      help: boolean,
    },
  });
  if (values.help) {
    process.stdout.write(help);
    return;
  }
  const flags = values as Record<string, string | boolean | undefined>;
  const value = (key: string) =>
    typeof flags[key] === "string" ? (flags[key] as string) : undefined;
  if (positionals.length !== (["init", "list", "caddy"].includes(command) ? 0 : 1))
    throw new Error(`Incorrect customer arguments for ${command}.`);
  acceleration();
  if (value("state-dir")) process.env.VEKTOR_HOST_STATE_DIR = value("state-dir");
  process.umask(0o077);
  const name = positionals[0];
  if (command === "list") {
    print(await list());
    return;
  }
  if (command === "status") {
    getCustomer(await readState(), name);
    print((await list()).find((entry) => entry.name === name));
    return;
  }
  if (command === "caddy") {
    process.stdout.write(await caddyConfig());
    return;
  }
  if (command === "exec") {
    if (!guestCommand.length) throw new Error("Use exec <name> -- <command> [args...].");
    await guestExec(getCustomer(await readState(), name), guestCommand, {
      stream: true,
      timeout: 0,
    });
    return;
  }
  if (command === "logs") {
    const customer = getCustomer(await readState(), name);
    if (flags.console)
      await run(
        [
          "tail",
          "-n",
          "100",
          ...(flags.follow ? ["-f"] : []),
          `${customerDirectory(name)}/console.log`,
        ],
        { stream: true, timeout: 0 },
      );
    else
      await guestExec(
        customer,
        [
          "sudo",
          "journalctl",
          "--unit=vektor.service",
          "--lines=100",
          "--no-pager",
          ...(flags.follow ? ["--follow"] : []),
        ],
        { stream: true, timeout: 0 },
      );
    return;
  }
  await withLock(async () => {
    switch (command) {
      case "init":
        print(await initialize({ image: value("image"), firmware: value("firmware") }));
        break;
      case "create":
        print(
          await create({
            name,
            binary: value("binary"),
            domain: value("domain"),
            env: value("env"),
            cpus: value("cpus") === undefined ? undefined : Number(value("cpus")),
            memory: value("memory"),
            disk: value("disk"),
            network: value("network"),
          }),
        );
        break;
      case "start":
      case "stop":
      case "restart":
        await changePower(name, command);
        break;
      case "backup":
        print({ backup: await backup(name, value("backup-dir")) });
        break;
      case "update": {
        const binary = value("binary");
        if (!binary) throw new Error("--binary is required.");
        print(await update(name, binary, value("backup-dir")));
        break;
      }
      case "remove":
        await remove(name);
        print({ name, retainedData: `${customerDirectory(name)}/data.qcow2` });
        break;
    }
  });
}

if (import.meta.main)
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
