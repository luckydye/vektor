// Opt-in acceptance test: boots REAL QEMU guests using HVF or KVM, never TCG.
// Run: bun test/live.ts /path/to/ubuntu-cloud.qcow2
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { guestExec, monitor, running, stop } from "#host/qemu.ts";
import { type Customer, readState } from "#host/state.ts";

const directory = await mkdtemp(join(tmpdir(), "vektor-live-"));
process.env.VEKTOR_HOST_STATE_DIR = directory;
const image = process.argv[2];
if (!image) throw new Error("Pass an Ubuntu cloud image matching the host architecture.");
const cli = resolve(import.meta.dir, "../src/cli.ts");
async function command(...args: string[]): Promise<string> {
  const child = Bun.spawn([process.execPath, cli, ...args, "--state-dir", directory], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, VEKTOR_HOST_STATE_DIR: directory },
  });
  const result = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0, `CLI failed: ${args.join(" ")}`);
  return result.trim();
}
let customer: Customer | undefined;
let cleaned = true;
const marker = `persistent-${Date.now()}`;
try {
  await command("init", "--image", resolve(image));
  await command("create", "acceptance", "--memory", "1GiB", "--disk", "1GiB");
  customer = (await readState()).customers.acceptance;
  assert.equal(customer.phase, "ready");
  assert.equal(
    await guestExec(customer, ["uname", "-m"]),
    process.arch === "arm64" ? "aarch64" : "x86_64",
  );
  assert.equal(
    (await monitor<{ status: string }>(customer, "query-status")).status,
    "running",
  );
  console.log("PASS: native QEMU boot, cloud-init, pinned SSH, QMP");
  await guestExec(customer, [
    "sudo",
    "sh",
    "-c",
    `printf '%s' '${marker}' > /var/lib/vektor/persistence-marker`,
  ]);
  await guestExec(customer, [
    "sudo",
    "systemd-run",
    "--unit=vektor-http-test",
    "python3",
    "-m",
    "http.server",
    "8080",
    "--bind",
    "0.0.0.0",
  ]);
  let connected = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${customer.httpPort}`, {
        signal: AbortSignal.timeout(2000),
      });
      await response.body?.cancel();
      if (response.ok) {
        connected = true;
        break;
      }
    } catch {
      /* HTTP listener is starting. */
    }
    await Bun.sleep(250);
  }
  assert.equal(connected, true, "host-to-guest HTTP forwarding");
  console.log("PASS: host-to-guest HTTP forwarding");
  await command("restart", "acceptance");
  assert.equal(
    await guestExec(customer, ["sudo", "cat", "/var/lib/vektor/persistence-marker"]),
    marker,
  );
  console.log("PASS: graceful restart preserves data");
  const result = JSON.parse(await command("backup", "acceptance"));
  const manifest = JSON.parse(
    await readFile(join(result.backup, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.customer.id, customer.id);
  for (const file of [
    "root.qcow2",
    "data.qcow2",
    "seed.iso",
    "id_ed25519",
    "known_hosts",
  ])
    assert.equal(await Bun.file(join(result.backup, file)).exists(), true);
  assert.equal(await running(customer), true);
  console.log("PASS: stopped-disk backup and automatic restart");
  await command("remove", "acceptance");
  assert.equal(await running(customer), false);
  assert.equal(
    await Bun.file(join(directory, "vms/acceptance/data.qcow2")).exists(),
    true,
  );
  await command("create", "acceptance");
  customer = (await readState()).customers.acceptance;
  assert.equal(
    await guestExec(customer, ["sudo", "cat", "/var/lib/vektor/persistence-marker"]),
    marker,
  );
  console.log("PASS: remove/recreate preserves customer data and credentials");
  await command("stop", "acceptance");
  assert.equal(await running(customer), false);
  const inventory = JSON.parse(await command("list"));
  assert.equal(inventory[0].status, "Stopped");
  console.log("PASS: graceful shutdown and status");
} finally {
  try {
    const state = await readState();
    for (const entry of Object.values(state.customers)) await stop(entry);
  } catch (error) {
    cleaned = false;
    console.error(`Cleanup needs attention; retained ${directory}: ${String(error)}`);
  }
  if (cleaned) await rm(directory, { recursive: true, force: true });
}
