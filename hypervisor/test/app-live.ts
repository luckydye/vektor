// Exercise deployment/update recovery in real VMs with a small Linux test service.
// This validates the host CLI, not Vektor's full application/native modules.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { run } from "#host/process.ts";
import { guestExec, stop } from "#host/qemu.ts";
import { readState } from "#host/state.ts";

const image = process.argv[2];
if (!image) throw new Error("Pass an Ubuntu cloud image matching the host architecture.");
const directory = await mkdtemp(join(tmpdir(), "vektor-app-live-"));
process.env.VEKTOR_HOST_STATE_DIR = directory;
const cli = resolve(import.meta.dir, "../src/cli.ts");
const command = (...args: string[]) =>
  run([process.execPath, cli, ...args, "--state-dir", directory]);
let clean = true;
try {
  await command("init", "--image", resolve(image));
  const source = join(directory, "fixture.ts");
  const binary = join(directory, "fixture");
  const build = async (version: number, broken = false) => {
    await writeFile(
      source,
      `if (process.argv[2] === "__native-self-test") process.exit(${broken ? 1 : 0});\nBun.serve({ hostname: "0.0.0.0", port: 8080, fetch: () => Response.json({ version: ${version} }) });\n`,
    );
    await run([
      process.execPath,
      "build",
      "--compile",
      `--target=bun-linux-${process.arch}`,
      source,
      "--outfile",
      binary,
    ]);
  };
  await build(1);
  const env = join(directory, "env.json");
  await writeFile(env, '{"VEKTOR_EMAIL_AUTH":"1"}');
  console.log("Provisioning app VM and installing real guest dependencies...");
  await command(
    "create",
    "appcheck",
    "--binary",
    binary,
    "--domain",
    "appcheck.localhost",
    "--env",
    env,
    "--memory",
    "1GiB",
    "--disk",
    "1GiB",
  );
  let customer = (await readState()).customers.appcheck;
  const readVersion = async () => {
    const response = await fetch(
      `http://127.0.0.1:${customer.httpPort}/api/v1/openapi.json`,
      { signal: AbortSignal.timeout(5000) },
    );
    assert.equal(response.status, 200);
    return (await response.json()).version;
  };
  assert.equal(await readVersion(), 1);
  assert.equal(
    await guestExec(customer, ["sudo", "systemctl", "is-active", "vektor.service"]),
    "active",
  );
  console.log(
    "PASS: guest dependency installation, binary upload, systemd and HTTP readiness",
  );
  const originalSecrets = await readFile(
    join(directory, "vms/appcheck/vektor.env"),
    "utf8",
  );
  await build(2);
  await command("update", "appcheck", "--binary", binary);
  customer = (await readState()).customers.appcheck;
  assert.equal(await readVersion(), 2);
  assert.equal(customer.phase, "ready");
  assert.ok(customer.lastBackup);
  assert.equal(await Bun.file(join(customer.lastBackup, "manifest.json")).exists(), true);
  assert.equal(
    await readFile(join(directory, "vms/appcheck/vektor.env"), "utf8"),
    originalSecrets,
  );
  console.log("PASS: pre-update backup, real binary replacement and retained secrets");
  await build(3, true);
  await assert.rejects(command("update", "appcheck", "--binary", binary));
  assert.equal(await readVersion(), 2);
  assert.equal((await readState()).customers.appcheck.phase, "ready");
  console.log("PASS: a failing candidate self-test leaves the existing service running");
} finally {
  try {
    for (const customer of Object.values((await readState()).customers))
      await stop(customer);
  } catch (error) {
    clean = false;
    console.error(`Cleanup needs attention; retained ${directory}: ${String(error)}`);
  }
  if (clean) await rm(directory, { recursive: true, force: true });
}
