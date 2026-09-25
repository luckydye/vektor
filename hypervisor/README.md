# Vektor host

A CLI for running customer VMs **directly on macOS and Linux** with QEMU.
macOS uses Apple's Hypervisor.framework (`hvf`); Linux uses KVM. Each customer
gets its own Linux kernel, QEMU process, root disk and persistent data disk.
There is no Incus, Docker, intermediate Linux VM, or emulation fallback.

Guests match the host architecture: ARM64 on Apple Silicon/ARM Linux, x64 on
Intel Macs/x64 Linux. A Vektor executable deployed into either guest must be a
**Linux** executable for that architecture, even when the host is a Mac.

## Install

On macOS:

```sh
brew install qemu
```

On Ubuntu/Debian Linux:

```sh
sudo apt-get install qemu-system-arm qemu-system-x86 qemu-utils qemu-efi-aarch64 genisoimage openssh-client curl
```

The Linux user running the CLI needs access to `/dev/kvm`. Run all commands as
the same user; running the CLI as root is unnecessary on Mac. macOS supplies
`hdiutil` for cloud-init seed images; Linux uses `genisoimage` or `mkisofs`.

From the repository:

```sh
bun install
cd hypervisor
bun run build
./dist/vektor-host init
./dist/vektor-host create acme
./dist/vektor-host list
./dist/vektor-host exec acme -- uname -a
```

`build` produces a standalone executable for the current host. `build:linux`
cross-compiles the CLI for Linux x64. QEMU and OpenSSH remain runtime dependencies.
For development, use `bun src/cli.ts` in place of the compiled executable.

`init` downloads the Ubuntu 24.04 cloud image, verifies its SHA-256 against the
manifest fetched over HTTPS from Ubuntu, and caches it. Alternatively, supply
`init --image /path/to/trusted-cloud.qcow2`. ARM firmware is located automatically;
use `--firmware /path/to/uefi.fd` if your distribution stores it elsewhere.

## Create and operate VMs

```sh
vektor-host create acme --cpus 2 --memory 2GiB --disk 20GiB
vektor-host status acme
vektor-host exec acme -- sudo ls /var/lib/vektor
vektor-host logs acme --console --follow
vektor-host stop acme
vektor-host start acme
vektor-host restart acme
vektor-host backup acme --backup-dir /path/to/backups
vektor-host remove acme
vektor-host create acme
```

The default root disk is at least 10 GiB. `--disk` sets the separate data disk,
mounted at `/var/lib/vektor`. Disks use qcow2 and grow as data is written.
The root image is flattened for each VM so disks and backups do not depend on
an external backing file. CPU counts are vCPUs, not dedicated physical cores.

The CLI generates separate administration and SSH host keys per customer. Host
keys are pinned before first boot. QMP lifecycle commands verify the VM identity;
shutdown is graceful and fails rather than forcibly killing an unresponsive VM.
Creation can be retried with its original settings after a failure.

`remove` deletes the root disk and cloud-init seed, preserving the data disk,
credentials and port reservations. A subsequent `create` builds a new root and
reattaches the retained data. Missing retained data is an error; the CLI never
silently substitutes a blank disk.

## Networking

Each VM has its own QEMU user-mode network. SSH and HTTP are forwarded to unique
ports on **127.0.0.1 only**; `list` reports `sshPort` and `httpPort`. The app is
reachable from the host at `http://127.0.0.1:<httpPort>` without root privileges,
host bridges, or changes to the host firewall.
Port reservations belong to the inventory. If another process takes a reserved
port, stop that process and retry; the CLI does not terminate it or silently move
an existing customer's endpoint.

`--network nat` is the default and permits outbound connections through the
host. It is **not an egress firewall**: guests can reach host/LAN services. This
version provides VM isolation, but NAT mode alone is not a complete network
security policy for untrusted tenants. `--network isolated` blocks outbound host
and internet traffic while preserving the explicit SSH/HTTP forwards. It works
for plain VMs; package installation, OAuth and outbound app jobs need NAT or a
separately prepared image/network policy. No host directories are shared into VMs.

## Agent browsers, graphics and WebGPU

VMs currently run headlessly, without a graphical desktop or configured GPU
acceleration. They can host headless Chromium with Playwright or Puppeteer;
browser binaries and their Linux dependencies must be installed separately for
the guest architecture. Browser automation has not yet been covered by the live
tests. Internet browsing requires outbound networking; `--network isolated`
blocks it.

Headless mode does not prevent GPU use: Chrome can run WebGPU workloads headlessly
when a compatible GPU backend and drivers are available. However, **the current
CLI does not configure hardware-accelerated WebGPU on either platform**.

| Host | Current configuration | Additional work for GPU-backed WebGPU |
| --- | --- | --- |
| macOS | HVF accelerates the guest CPU; it does not expose the Apple GPU to the guest. | A separate graphics virtualization/translation stack would be needed. No working Mac GPU path has been implemented or verified here. |
| Linux | KVM accelerates the guest CPU; no accelerated virtual GPU is configured. | A possible path is virtio-gpu with virglrenderer/Venus for guest Vulkan, compatible host/guest drivers, and validation in Chromium. This is not implemented or verified here. |

Software rendering may be useful for compatibility testing, but it is CPU work
and should not be treated as evidence of hardware GPU acceleration. A future
WebGPU acceptance test should request an adapter/device, inspect the selected
backend, and run an actual workload; detecting `navigator.gpu` alone is not enough.

Adding VNC/noVNC or a desktop would provide a visible screen, but would not by
itself enable GPU acceleration or WebGPU. There is currently no GPU CLI option.

References: [Chrome headless WebGPU testing](https://developer.chrome.com/blog/supercharge-web-ai-testing),
[QEMU virtio-gpu backends](https://www.qemu.org/docs/master/system/devices/virtio/virtio-gpu.html),
[Mesa Venus requirements](https://docs.mesa3d.org/drivers/venus.html).

## Deploy Vektor

Create an environment JSON file:

```json
{ "VEKTOR_EMAIL_AUTH": "1" }
```

Then deploy a trusted Linux binary matching your host's architecture:

```sh
vektor-host create acme \
  --binary /path/to/vektor-linux-arm64 \
  --domain acme.example.com \
  --env /path/to/acme.json
vektor-host logs acme --follow
vektor-host update acme --binary /path/to/new-vektor-linux-arm64
vektor-host caddy
```

The guest installs the tools in Vektor's Dockerfile and runs the binary as an
unprivileged `vektor` user under systemd. Customer data and secrets are separate.
On ARM64, htmlq 0.4.0 is compiled in the guest because upstream publishes no
Linux ARM64 binary for that version; first app provisioning takes longer.
Authentication/encryption keys are generated independently and retained across
retries. No-auth, in-memory databases and private-network job fetches are disabled.
This version requires local database/file storage to keep data within backups.

`caddy` renders a Caddyfile include pointing at the loopback HTTP ports, blocking
public `/metrics`. It does not install or reload Caddy. Configure DNS/TLS for the
domain passed to `create`; local HTTPS can use a hostname such as
`acme.localhost` with Caddy's local CA. Authentication expects the configured
HTTPS origin, not the raw forwarded HTTP URL.

Updates take a stopped-VM backup first, deploy the binary, and wait for the app's
OpenAPI endpoint. Interrupted activations remain `updating`; retrying preserves
the original backup. There is no automatic binary/database downgrade. OS patching
and application signup policy remain separate operator/application tasks.

## Backups and state

State defaults to `~/.local/share/vektor-host`. Every command accepts `--state-dir`;
`VEKTOR_HOST_STATE_DIR` also sets it. Inventory writes are atomic, state directories
are private, and credentials are mode 0600. Mutations take one exclusive lock.
After an interrupted command, inspect its recorded PID and child processes before
manually removing a stale `operation.lock`.

Backups contain flattened `root.qcow2` and `data.qcow2`, the cloud-init seed,
SSH credentials, app configuration when present, and ARM firmware when needed.
`manifest.json` is written last to distinguish completed backups. A running VM
is stopped during copying and restarted afterward. Copy backups to encrypted
off-host storage and retain the inventory too. Restore is currently an operator
procedure using the manifest and disk files, not a CLI command.

VMs continue running when the CLI exits, but automatic startup after a host reboot
is not implemented. This version has no scheduler, capacity admission controller,
automatic failover, disk resize, or fleet management. The app's pending collaborative
edits also need a durable shutdown path; disk backups cannot repair that app-level gap.

## Tests

```sh
task check:host
task test:host
cd hypervisor
bun test/live.ts /path/to/ubuntu-cloud.qcow2
bun test/app-live.ts /path/to/ubuntu-cloud.qcow2
```

Unit tests cover platform selection, arguments, QMP identity checks, state locks,
credentials and process I/O. The opt-in live test boots real hardware-accelerated
VMs, checks SSH/HTTP, restarts, backs up, removes/recreates with persistent data,
then stops and removes its temporary resources. It requires QEMU and a cloud
image matching the host. It does not validate the complete Vektor application.
The app live test also installs guest dependencies and verifies deployment,
updates and failed-candidate handling with a small compiled Linux test service.

References: [QEMU accelerators](https://www.qemu.org/docs/master/system/introduction.html),
[QEMU networking](https://www.qemu.org/docs/master/system/qemu-manpage.html),
[cloud-init NoCloud](https://docs.cloud-init.io/en/latest/reference/datasources/nocloud.html).
