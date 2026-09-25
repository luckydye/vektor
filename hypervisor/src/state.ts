import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Customer {
  name: string;
  id: string;
  cpus: number;
  memory: string;
  disk: string;
  sshPort: number;
  httpPort: number;
  network: "nat" | "isolated";
  domain?: string;
  phase: "creating" | "ready" | "updating" | "removed";
  dataCreated?: boolean;
  binarySha256?: string;
  pendingBinarySha256?: string;
  lastBackup?: string;
  createdAt: string;
}

export interface HostState {
  version: 1;
  driver: "qemu";
  arch: "arm64" | "x64";
  image: string;
  firmware?: string;
  customers: Record<string, Customer>;
}

export function stateDirectory(): string {
  return resolve(
    process.env.VEKTOR_HOST_STATE_DIR || join(homedir(), ".local/share/vektor-host"),
  );
}

export function customerName(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(value))
    throw new Error("Customer names must be 2–32 lowercase letters, digits or hyphens.");
  return value;
}

export function customerDirectory(name: string): string {
  return join(stateDirectory(), "vms", customerName(name));
}

export function environmentPath(name: string): string {
  return join(customerDirectory(name), "vektor.env");
}

export function domainName(value: string): string {
  const domain = value.toLowerCase();
  if (
    domain.length > 253 ||
    !domain.includes(".") ||
    !domain
      .split(".")
      .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
    /^\d+(?:\.\d+){3}$/.test(domain)
  )
    throw new Error("--domain must be a DNS hostname without a scheme, port or path.");
  return domain;
}

export function capacity(value: string): string {
  if (!/^[1-9]\d*(?:MiB|GiB)$/.test(value))
    throw new Error("Sizes must use MiB or GiB, for example 2GiB.");
  if (!Number.isSafeInteger(capacityBytes(value))) throw new Error("Size is too large.");
  return value;
}

export function capacityBytes(value: string): number {
  return Number.parseInt(value, 10) * (value.endsWith("GiB") ? 1024 ** 3 : 1024 ** 2);
}

export function getCustomer(state: HostState, name: string): Customer {
  customerName(name);
  if (!Object.hasOwn(state.customers, name)) throw new Error(`Unknown customer: ${name}`);
  return state.customers[name];
}

export async function atomicWrite(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readState(): Promise<HostState> {
  let state: HostState;
  try {
    state = JSON.parse(await readFile(join(stateDirectory(), "state.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("Host is not initialized. Run vektor-host init.");
    throw error;
  }
  if (
    state?.version !== 1 ||
    state.driver !== "qemu" ||
    !state.image ||
    !state.customers ||
    Array.isArray(state.customers)
  )
    throw new Error("Invalid QEMU host state. Restore state.json from a backup.");
  if (state.arch !== process.arch)
    throw new Error(
      `Host state is for ${state.arch}, but this machine is ${process.arch}.`,
    );
  return state;
}

export function writeState(state: HostState): Promise<void> {
  return atomicWrite(
    join(stateDirectory(), "state.json"),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

export async function withLock<T>(action: () => Promise<T>): Promise<T> {
  await mkdir(stateDirectory(), { recursive: true, mode: 0o700 });
  const path = join(stateDirectory(), "operation.lock");
  let lock: FileHandle;
  try {
    lock = await open(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(
      `Host operation is locked (${path}, PID ${(await readFile(path, "utf8")).trim() || "pending"}). Confirm that the process and its children have finished before removing a stale lock.`,
    );
  }
  try {
    await lock.writeFile(String(process.pid));
    return await action();
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}
