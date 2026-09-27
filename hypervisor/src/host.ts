import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import {
  activateBinary,
  cloudConfig,
  environment,
  prepareData,
  prepareGuest,
} from "./guest.ts";
import { imageInfo, prepareFirmware, prepareImage, seedImage } from "./image.ts";
import { run } from "./process.ts";
import {
  acceleration,
  guestExec,
  guestPush,
  running,
  start,
  stop,
  waitForSSH,
} from "./qemu.ts";
import {
  atomicWrite,
  type Customer,
  capacity,
  capacityBytes,
  customerDirectory,
  customerName,
  domainName,
  environmentPath,
  getCustomer,
  type HostState,
  readState,
  stateDirectory,
  writeState,
} from "./state.ts";

export async function initialize(options: {
  image?: string;
  firmware?: string;
}): Promise<HostState> {
  acceleration();
  if (await Bun.file(join(stateDirectory(), "state.json")).exists()) {
    if (options.image || options.firmware)
      throw new Error(
        "Already initialized; use a separate --state-dir for another base image.",
      );
    return readState();
  }
  await run([acceleration().executable, "--version"]);
  if (process.platform === "linux" && !(await Bun.file("/dev/kvm").exists()))
    throw new Error("KVM is required on Linux; /dev/kvm is missing.");
  const firmware = await prepareFirmware(options.firmware);
  const image = await prepareImage(options.image);
  const state: HostState = {
    version: 1,
    driver: "qemu",
    arch: process.arch as HostState["arch"],
    image,
    firmware,
    customers: {},
  };
  await writeState(state);
  return state;
}

async function freePort(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}

async function allocatePorts(
  state: HostState,
): Promise<{ sshPort: number; httpPort: number }> {
  const used = new Set(
    Object.values(state.customers).flatMap((entry) => [entry.sshPort, entry.httpPort]),
  );
  for (let port = 22000; port < 32000; port += 2) {
    if (
      !used.has(port) &&
      !used.has(port + 1) &&
      (await freePort(port)) &&
      (await freePort(port + 1))
    )
      return { sshPort: port, httpPort: port + 1 };
  }
  throw new Error("No available VM port pairs.");
}

async function keyPair(path: string): Promise<void> {
  if (!(await Bun.file(path).exists()))
    await run([
      "ssh-keygen",
      "-q",
      "-t",
      "ed25519",
      "-N",
      "",
      "-C",
      "vektor-host",
      "-f",
      path,
    ]);
  if (!(await Bun.file(`${path}.pub`).exists()))
    await atomicWrite(`${path}.pub`, await run(["ssh-keygen", "-y", "-f", path]));
}

async function disksAndSeed(state: HostState, customer: Customer): Promise<void> {
  const directory = customerDirectory(customer.name);
  const data = join(directory, "data.qcow2");
  if (!(await Bun.file(data).exists())) {
    if (customer.dataCreated)
      throw new Error(
        "Retained customer data disk is missing; restore it before continuing.",
      );
    await run([
      "qemu-img",
      "create",
      "-f",
      "qcow2",
      data,
      String(capacityBytes(customer.disk)),
    ]);
    await chmod(data, 0o600);
  }
  customer.dataCreated = true;
  await writeState(state);
  const root = join(directory, "root.qcow2");
  if (!(await Bun.file(root).exists())) {
    const temporary = `${root}.tmp`;
    await rm(temporary, { force: true });
    // Flatten each root disk: backups and customer disks have no base-image dependency.
    await run(["qemu-img", "convert", "-O", "qcow2", state.image, temporary]);
    const size = Math.max(10 * 1024 ** 3, (await imageInfo(temporary))["virtual-size"]);
    await run(["qemu-img", "resize", temporary, String(size)]);
    await chmod(temporary, 0o600);
    await rename(temporary, root);
  }
  await keyPair(join(directory, "id_ed25519"));
  await keyPair(join(directory, "ssh_host_ed25519_key"));
  const hostPublic = await readFile(join(directory, "ssh_host_ed25519_key.pub"), "utf8");
  await atomicWrite(
    join(directory, "known_hosts"),
    `[127.0.0.1]:${customer.sshPort} ${hostPublic.trim()}\n`,
  );
  if (!(await Bun.file(join(directory, "seed.iso")).exists())) {
    const seed = join(directory, "seed");
    await mkdir(seed, { recursive: true, mode: 0o700 });
    await atomicWrite(
      join(seed, "user-data"),
      cloudConfig(
        await readFile(join(directory, "id_ed25519.pub"), "utf8"),
        await readFile(join(directory, "ssh_host_ed25519_key"), "utf8"),
        hostPublic,
      ),
    );
    await atomicWrite(
      join(seed, "meta-data"),
      JSON.stringify({ "instance-id": customer.id, "local-hostname": customer.name }),
    );
    await seedImage(directory);
  }
}

async function binaryFile(
  path: string,
): Promise<{ file: ReturnType<typeof Bun.file>; sha256: string }> {
  const file = Bun.file(resolve(path));
  const header = new Uint8Array(await file.slice(0, 20).arrayBuffer());
  const machine = process.arch === "arm64" ? 183 : 62;
  if (
    header.length < 20 ||
    header[0] !== 127 ||
    header[1] !== 69 ||
    header[2] !== 76 ||
    header[3] !== 70 ||
    header[4] !== 2 ||
    header[5] !== 1 ||
    (header[18] | (header[19] << 8)) !== machine
  )
    throw new Error(
      `Expected a Linux ELF binary matching the VM architecture (${process.arch}).`,
    );
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hash.update(chunk);
  return { file, sha256: hash.digest("hex") };
}

async function waitForApp(customer: Customer): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${customer.httpPort}/api/v1/openapi.json`,
        { signal: AbortSignal.timeout(3000), redirect: "manual" },
      );
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch {
      /* Service is starting. */
    }
    await Bun.sleep(1500);
  }
  throw new Error(`Vektor did not become ready; run vektor-host logs ${customer.name}.`);
}

export interface CreateOptions {
  name: string;
  binary?: string;
  domain?: string;
  env?: string;
  cpus?: number;
  memory?: string;
  disk?: string;
  network?: string;
}

export async function create(options: CreateOptions): Promise<Customer> {
  const state = await readState();
  const name = customerName(options.name);
  const binary = options.binary ? await binaryFile(options.binary) : undefined;
  let customer = Object.hasOwn(state.customers, name) ? state.customers[name] : undefined;
  if (customer) {
    if (customer.phase === "updating")
      throw new Error("An update is unfinished; retry update or restore the backup.");
    for (const field of ["cpus", "memory", "disk", "network", "domain"] as const)
      if (options[field] !== undefined && options[field] !== customer[field])
        throw new Error(`Retry must preserve ${field}.`);
    if (customer.phase === "ready") {
      if (binary && binary.sha256 !== customer.binarySha256)
        throw new Error("Customer exists; use update to deploy a binary.");
      return customer;
    }
    if (customer.domain && !binary)
      throw new Error("Recreating this app VM requires --binary.");
  } else {
    if (binary && (!options.domain || !options.env))
      throw new Error("App deployment requires --domain and --env.");
    if (!binary && (options.domain || options.env))
      throw new Error("--domain and --env require --binary.");
    const cpus = options.cpus ?? 2;
    if (!Number.isInteger(cpus) || cpus < 1 || cpus > 256)
      throw new Error("--cpus must be 1–256.");
    const network = options.network ?? "nat";
    if (network !== "nat" && network !== "isolated")
      throw new Error("--network must be nat or isolated.");
    const domain = options.domain ? domainName(options.domain) : undefined;
    if (domain && Object.values(state.customers).some((entry) => entry.domain === domain))
      throw new Error("Domain is already assigned.");
    customer = {
      name,
      id: randomUUID(),
      cpus,
      memory: capacity(options.memory || "2GiB"),
      disk: capacity(options.disk || "20GiB"),
      ...(await allocatePorts(state)),
      domain,
      network,
      phase: "creating",
      createdAt: new Date().toISOString(),
    };
    await mkdir(customerDirectory(name), { recursive: true, mode: 0o700 });
    if (options.env && domain)
      await atomicWrite(environmentPath(name), await environment(options.env, domain));
    state.customers[name] = customer;
    await writeState(state);
  }
  customer.phase = "creating";
  await writeState(state);
  await disksAndSeed(state, customer);
  process.stderr.write(
    `Booting ${name} directly with QEMU/${acceleration().accelerator}...\n`,
  );
  await start(state, customer);
  await waitForSSH(customer);
  await guestExec(customer, ["sudo", "cloud-init", "status", "--wait"]);
  await guestPush(customer, "/usr/local/sbin/vektor-data", prepareData, "0700");
  await guestExec(customer, ["sudo", "/usr/local/sbin/vektor-data"]);
  if (binary) {
    await guestPush(customer, "/usr/local/sbin/vektor-prepare", prepareGuest, "0700");
    await guestExec(customer, [
      "sudo",
      "sh",
      "-c",
      "test -f /usr/local/lib/vektor/bootstrap-complete || /usr/local/sbin/vektor-prepare",
    ]);
    await guestPush(
      customer,
      "/etc/vektor/vektor.env",
      await readFile(environmentPath(name), "utf8"),
      "0600",
    );
    await guestPush(customer, "/usr/local/lib/vektor/candidate", binary.file, "0755");
    await guestExec(customer, ["sudo", "sh", "-s"], { input: activateBinary });
    await waitForApp(customer);
    customer.binarySha256 = binary.sha256;
  }
  customer.phase = "ready";
  delete customer.pendingBinarySha256;
  await writeState(state);
  return customer;
}

export async function list(): Promise<Array<Customer & { status: string }>> {
  const state = await readState();
  return Promise.all(
    Object.values(state.customers).map(async (customer) => ({
      ...customer,
      status: (await running(customer)) ? "Running" : "Stopped",
    })),
  );
}

export async function changePower(
  name: string,
  action: "start" | "stop" | "restart",
): Promise<void> {
  const state = await readState();
  const customer = getCustomer(state, name);
  if (action !== "start") await stop(customer);
  if (action !== "stop") {
    if (customer.phase === "removed")
      throw new Error("VM was removed; use create to recreate it.");
    await start(state, customer);
    await waitForSSH(customer);
    if (customer.binarySha256) await waitForApp(customer);
  }
}

export async function backup(name: string, parent?: string): Promise<string> {
  const state = await readState();
  const customer = getCustomer(state, name);
  if (customer.phase === "removed") throw new Error("Cannot back up a removed VM.");
  const destination = join(
    resolve(parent || join(stateDirectory(), "backups")),
    `${name}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const wasRunning = await running(customer);
  await stop(customer);
  try {
    for (const file of ["root.qcow2", "data.qcow2"]) {
      await run([
        "qemu-img",
        "convert",
        "-O",
        "qcow2",
        join(customerDirectory(name), file),
        join(destination, file),
      ]);
      await chmod(join(destination, file), 0o600);
    }
    for (const file of [
      "seed.iso",
      "id_ed25519",
      "id_ed25519.pub",
      "ssh_host_ed25519_key",
      "ssh_host_ed25519_key.pub",
      "known_hosts",
      ...(customer.domain ? ["vektor.env"] : []),
    ]) {
      await copyFile(join(customerDirectory(name), file), join(destination, file));
      await chmod(join(destination, file), 0o600);
    }
    if (state.firmware) await copyFile(state.firmware, join(destination, "firmware.fd"));
    await atomicWrite(
      join(destination, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          driver: "qemu",
          arch: state.arch,
          customer,
          createdAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    if (wasRunning) await start(state, customer);
  }
  return destination;
}

export async function update(
  name: string,
  path: string,
  backupDirectory?: string,
): Promise<Customer> {
  const state = await readState();
  const customer = getCustomer(state, name);
  if (!customer.domain || !["ready", "updating"].includes(customer.phase))
    throw new Error("Only an existing app VM can be updated.");
  const binary = await binaryFile(path);
  await waitForSSH(customer);
  await guestPush(customer, "/usr/local/lib/vektor/candidate", binary.file, "0755");
  await guestExec(customer, [
    "sudo",
    "/usr/local/lib/vektor/candidate",
    "__native-self-test",
  ]);
  const destination =
    customer.phase === "updating" && customer.lastBackup
      ? customer.lastBackup
      : await backup(name, backupDirectory);
  customer.phase = "updating";
  customer.pendingBinarySha256 = binary.sha256;
  customer.lastBackup = destination;
  await writeState(state);
  try {
    await waitForSSH(customer);
    await guestExec(customer, ["sudo", "sh", "-s"], { input: activateBinary });
    await waitForApp(customer);
  } catch (error) {
    throw new Error(
      `${String(error)}\nPre-update backup: ${destination}\nNo automatic database downgrade was attempted.`,
    );
  }
  customer.binarySha256 = binary.sha256;
  customer.phase = "ready";
  delete customer.pendingBinarySha256;
  await writeState(state);
  return customer;
}

export async function remove(name: string): Promise<void> {
  const state = await readState();
  const customer = getCustomer(state, name);
  await stop(customer);
  // Data and credentials survive; a fresh root disk can reuse them.
  const root = join(customerDirectory(name), "root.qcow2");
  // An orphaned QEMU with a missing monitor still holds its disk lock.
  if (await Bun.file(root).exists()) await imageInfo(root);
  await rm(root, { force: true });
  await rm(join(customerDirectory(name), "seed.iso"), { force: true });
  customer.phase = "removed";
  await writeState(state);
}

export async function caddyConfig(): Promise<string> {
  const state = await readState();
  return Object.values(state.customers)
    .filter(
      (customer) => customer.domain && ["ready", "updating"].includes(customer.phase),
    )
    .map(
      (customer) =>
        `${domainName(customer.domain || "")} {\n  @metrics path /metrics\n  respond @metrics 404\n  reverse_proxy 127.0.0.1:${customer.httpPort}\n}\n`,
    )
    .join("\n");
}
