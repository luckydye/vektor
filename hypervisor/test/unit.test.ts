import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activateBinary,
  cloudConfig,
  environment,
  prepareData,
  prepareGuest,
} from "#host/guest.ts";
import { run, shellQuote } from "#host/process.ts";
import { acceleration, monitor, qemuArguments, running, socketPath } from "#host/qemu.ts";
import {
  atomicWrite,
  type Customer,
  capacity,
  capacityBytes,
  customerName,
  domainName,
  getCustomer,
  type HostState,
  readState,
  withLock,
  writeState,
} from "#host/state.ts";

let directory: string;
let previous: string | undefined;
let server: Server | undefined;
let customer: Customer;
let state: HostState;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "vektor-unit-"));
  previous = process.env.VEKTOR_HOST_STATE_DIR;
  process.env.VEKTOR_HOST_STATE_DIR = directory;
  customer = {
    name: "acme",
    id: randomUUID(),
    cpus: 2,
    memory: "2GiB",
    disk: "20GiB",
    sshPort: 22000,
    httpPort: 22001,
    network: "nat",
    phase: "ready",
    createdAt: "now",
  };
  state = {
    version: 1,
    driver: "qemu",
    arch: process.arch as HostState["arch"],
    image: "/image.qcow2",
    firmware: "/firmware.fd",
    customers: { acme: customer },
  };
});
afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
  await rm(socketPath(customer), { force: true });
  if (previous === undefined) delete process.env.VEKTOR_HOST_STATE_DIR;
  else process.env.VEKTOR_HOST_STATE_DIR = previous;
  await rm(directory, { recursive: true, force: true });
});

test("macOS and Linux select native hardware acceleration, with no emulation fallback", () => {
  expect(acceleration("darwin", "arm64")).toMatchObject({
    accelerator: "hvf",
    executable: "qemu-system-aarch64",
  });
  expect(acceleration("linux", "arm64").accelerator).toBe("kvm");
  expect(acceleration("darwin", "x64").accelerator).toBe("hvf");
  expect(acceleration("linux", "x64")).toMatchObject({
    accelerator: "kvm",
    executable: "qemu-system-x86_64",
  });
  expect(() => acceleration("win32", "x64")).toThrow();
});

test("QEMU launches have separate disks, loopback-only forwards and no shared host filesystem", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const args = qemuArguments(state, customer, platform);
    expect(args[args.indexOf("-accel") + 1]).toBe(platform === "darwin" ? "hvf" : "kvm");
    expect(args.join(" ")).toContain("hostfwd=tcp:127.0.0.1:22000-:22");
    expect(args.join(" ")).toContain("hostfwd=tcp:127.0.0.1:22001-:8080");
    expect(args.join(" ")).toContain("data.qcow2");
    expect(args).not.toContain("-virtfs");
    expect(args).not.toContain("-fsdev");
    expect(args).not.toContain("tcg");
  }
});

test("isolated networking explicitly blocks outbound networking", () => {
  customer.network = "isolated";
  expect(qemuArguments(state, customer).join(" ")).toContain("restrict=on");
});

test("ARM firmware is required and passed as its own argument", () => {
  state.arch = "arm64";
  expect(qemuArguments(state, customer)).toContain("/firmware.fd");
  delete state.firmware;
  expect(() => qemuArguments(state, customer)).toThrow("UEFI");
});

test("state paths containing QEMU commas are escaped", () => {
  process.env.VEKTOR_HOST_STATE_DIR = join(directory, "with,comma");
  expect(
    qemuArguments(state, customer).find((arg) => arg.includes("root.qcow2")),
  ).toContain("with,,comma");
  expect(Buffer.byteLength(socketPath(customer))).toBeLessThan(100);
  process.env.VEKTOR_HOST_STATE_DIR = directory;
});

test("state round-trips and atomic writes protect secrets", async () => {
  await writeState(state);
  expect(await readState()).toEqual(state);
  const path = join(directory, "secret");
  await writeFile(path, "old", { mode: 0o644 });
  await atomicWrite(path, "new");
  expect(await readFile(path, "utf8")).toBe("new");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("mutation locks exclude concurrent writers and release after errors", async () => {
  await withLock(async () => {
    await expect(withLock(async () => "unexpected")).rejects.toThrow("locked");
  });
  await expect(
    withLock(async () => {
      throw new Error("failure");
    }),
  ).rejects.toThrow("failure");
  expect(await withLock(async () => "released")).toBe("released");
});

test("stale locks are retained for inspection", async () => {
  await writeFile(join(directory, "operation.lock"), "99999999");
  await expect(withLock(async () => "unexpected")).rejects.toThrow("stale lock");
  expect(await Bun.file(join(directory, "operation.lock")).exists()).toBe(true);
});

test("invalid state and inherited customer names fail safely", async () => {
  await expect(readState()).rejects.toThrow("not initialized");
  await writeFile(join(directory, "state.json"), "null");
  await expect(readState()).rejects.toThrow("Invalid QEMU");
  expect(() => getCustomer(state, "constructor")).toThrow("Unknown customer");
});

test("name, domain and size validation rejects injection", () => {
  for (const name of ["../acme", "--all", "acme;id", "a"])
    expect(() => customerName(name)).toThrow();
  for (const domain of [
    "https://example.com",
    "example.com:80",
    "example.com\n}",
    "127.0.0.1",
  ])
    expect(() => domainName(domain)).toThrow();
  for (const size of ["-1GiB", "0GiB", "all", "999999999999999999GiB"])
    expect(() => capacity(size)).toThrow();
  expect(capacityBytes(capacity("2GiB"))).toBe(2 * 1024 ** 3);
});

test("environment secrets differ per customer and managed settings override input", async () => {
  const path = join(directory, "env.json");
  await writeFile(path, JSON.stringify({ VEKTOR_EMAIL_AUTH: "1", VEKTOR_NO_AUTH: "1" }));
  const first = await environment(path, "acme.example.com");
  expect(first).not.toBe(await environment(path, "other.example.com"));
  expect(first).toContain('VEKTOR_NO_AUTH="0"');
  expect(first).toContain('VEKTOR_DATA_DIR="/var/lib/vektor"');
  for (const key of ["AUTH_SECRET", "VEKTOR_SECRETS_ENCRYPTION_KEY"])
    expect(
      Buffer.from(first.match(new RegExp(`^${key}="([^"]+)"`, "m"))?.[1] || "", "base64")
        .length,
    ).toBe(32);
});

test("environment rejects missing authentication, external storage and newline injection", async () => {
  const path = join(directory, "env.json");
  for (const input of [
    {},
    { VEKTOR_EMAIL_AUTH: "1", VALUE: "x\nINJECTED=1" },
    { VEKTOR_EMAIL_AUTH: "1", VEKTOR_S3_BUCKET: "external" },
  ]) {
    await writeFile(path, JSON.stringify(input));
    await expect(environment(path, "acme.com")).rejects.toThrow();
  }
});

test("cloud-init pins the host key and disables password authentication", () => {
  const cloud = JSON.parse(
    cloudConfig("ssh-ed25519 public", "private", "ssh-ed25519 host").replace(
      /^#cloud-config\n/,
      "",
    ),
  );
  expect(cloud.ssh_pwauth).toBe(false);
  expect(cloud.ssh_keys.ed25519_private).toBe("private");
  expect(cloud.users[0].ssh_authorized_keys).toEqual(["ssh-ed25519 public"]);
});

test("guest scripts have valid POSIX shell syntax", async () => {
  for (const input of [prepareData, prepareGuest, activateBinary])
    expect(await run(["sh", "-n"], { input })).toBe("");
});

test("SSH command quoting preserves literal shell metacharacters", async () => {
  const value = "apostrophe' with $(echo hacked) `echo hacked` ; spaces";
  expect(await run(["sh", "-c", `printf '%s' ${shellQuote(value)}`])).toBe(value);
});

test("subprocess stdin streams multi-megabyte binary data without truncation", async () => {
  const payload = new Uint8Array(5 * 1024 * 1024 + 7).map((_, index) => index % 251);
  const expected = new Bun.CryptoHasher("sha256").update(payload).digest("hex");
  const actual = await run(
    [
      process.execPath,
      "-e",
      'const input = await Bun.stdin.arrayBuffer(); console.log(new Bun.CryptoHasher("sha256").update(input).digest("hex"));',
    ],
    { input: new Blob([payload]) },
  );
  expect(actual).toBe(expected);
});

test("subprocess errors preserve status and stderr", async () => {
  await expect(run(["sh", "-c", "echo deliberate >&2; exit 7"])).rejects.toThrow(
    "failed (7): deliberate",
  );
});

test("hung subprocess is killed on timeout", async () => {
  await expect(run(["sleep", "60"], { timeout: 50 })).rejects.toThrow("timed out");
});

async function qmpServer(identity: string): Promise<string[]> {
  const commands: string[] = [];
  await mkdir(dirname(socketPath(customer)), { recursive: true, mode: 0o700 });
  server = createServer((socket) => {
    socket.write('{"QMP":{"version":{}}}\r\n');
    let buffer = "";
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      let end = buffer.indexOf("\n");
      while (end !== -1) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        commands.push(request.execute);
        const result =
          request.execute === "query-name" ? { name: identity } : { status: "running" };
        socket.write(`${JSON.stringify({ return: result, id: request.id })}\r\n`);
        end = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((resolveServer, reject) => {
    server?.once("error", reject);
    server?.listen(socketPath(customer), resolveServer);
  });
  return commands;
}

test("QMP negotiates capabilities and verifies VM identity before commands", async () => {
  const commands = await qmpServer(`vektor-${customer.id}`);
  expect(await monitor<{ status: string }>(customer, "query-status")).toEqual({
    status: "running",
  });
  expect(commands).toEqual(["qmp_capabilities", "query-name", "query-status"]);
});

test("QMP rejects another VM without sending power commands", async () => {
  const commands = await qmpServer("unrelated-vm");
  await expect(monitor(customer, "system_powerdown")).rejects.toThrow(
    "identity mismatch",
  );
  expect(commands).not.toContain("system_powerdown");
});

test("a missing QMP socket means stopped", async () => {
  expect(await running(customer)).toBe(false);
});
