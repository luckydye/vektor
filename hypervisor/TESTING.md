# Verification — 2026-09-25

Host: Apple M5, macOS 27.0, QEMU 11.1.1, Bun 1.4.0.

Passed:

- `task check:host`: TypeScript and Biome for implementation, build and tests.
- `task test:host`: 21 tests, 71 assertions, zero failures.
- `bun run build`: native Mac executable, ad-hoc signed and launched successfully.
- `bun run build:linux`: Linux x64 cross-compiled executable.
- `bun test/live.ts <ubuntu-arm64-image>`: real QEMU/HVF VM boot, cloud-init,
  pinned SSH, QMP identity, HTTP forwarding, graceful restart, persistent data,
  stopped-disk backup, removal/recreation with retained data, shutdown and status.
- `bun test/app-live.ts <ubuntu-arm64-image>`: real guest dependencies, compiled
  Linux test-service upload, systemd startup, HTTP readiness, backup-before-update,
  binary replacement, retained secrets, and rejection of a failing candidate
  without stopping the existing service.
- Compiled CLI with a real `--network isolated` guest: SSH and forwarded HTTP
  worked; guest connections to host and internet were blocked.

The live tests used direct HVF acceleration. There was no intermediate host VM,
Incus, nested virtualization, or TCG fallback. All test guests were stopped.
Automated test directories were removed; the manual test directory and cached
cloud image were moved to macOS Trash.

Testing caught and corrected a conflicting Ubuntu system UID, an ACPI shutdown
request lost during early boot, invalid Mac executable signing, and a nonexistent
ARM64 htmlq release artifact. The ARM guest now builds the pinned htmlq version.

Limits:

- Live KVM execution on a Linux host has **not** been run. Linux acceleration and
  command construction have unit coverage, and the Linux x64 build passes.
- The app live test uses a small compiled test service, not the full Vektor
  application or its native modules.
- Repository-wide `task check` failed on 55 formatting/import errors in server
  files outside this change. Those files were not modified. The server typecheck
  was canceled by the failed parallel task; the hypervisor's own check passes.
