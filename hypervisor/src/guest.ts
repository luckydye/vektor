import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const service = `[Unit]
Description=Vektor
Wants=network-online.target
After=network-online.target
RequiresMountsFor=/var/lib/vektor

[Service]
Type=simple
User=vektor
Group=vektor
WorkingDirectory=/var/lib/vektor
EnvironmentFile=/etc/vektor/vektor.env
ExecStart=/usr/local/bin/vektor serve --port 8080
Restart=on-failure
RestartSec=3
TimeoutStopSec=120
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/vektor
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
`;

// The QEMU data device has a stable serial, independent of enumeration order.
// Only a signature-free volume is formatted. Existing volumes are never recreated.
export const prepareData = String.raw`#!/bin/sh
set -eu
if ! id vektor >/dev/null 2>&1; then
  useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin vektor
fi
test "$(id -u vektor)" = 10001
disk=/dev/disk/by-id/virtio-vektor-data
test -b "$disk"
kind=$(blkid -s TYPE -o value "$disk" || true)
if [ -z "$kind" ]; then
  test -z "$(wipefs --noheadings --output TYPE "$disk")"
  mkfs.ext4 -L vektor-data "$disk"
elif [ "$kind" != ext4 ]; then
  echo "Customer data disk has an unexpected filesystem; refusing to format it." >&2
  exit 1
fi
mkdir -p /var/lib/vektor /etc/vektor /usr/local/lib/vektor
if ! grep -q '^/dev/disk/by-id/virtio-vektor-data ' /etc/fstab; then
  printf '%s\n' '/dev/disk/by-id/virtio-vektor-data /var/lib/vektor ext4 defaults 0 2' >> /etc/fstab
fi
mountpoint -q /var/lib/vektor || mount /var/lib/vektor
chown vektor:vektor /var/lib/vektor
chmod 0700 /var/lib/vektor /etc/vektor
`;

export const prepareGuest = String.raw`#!/bin/sh
set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl git jq zstd librsvg2-bin e2fsprogs util-linux
/usr/local/sbin/vektor-data

# Match the tools shipped by Vektor's Dockerfile.
case "$(uname -m)" in
  x86_64) pandoc_arch=amd64 ;;
  aarch64) pandoc_arch=arm64 ;;
  *) echo 'Unsupported guest architecture' >&2; exit 1 ;;
esac
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
if ! command -v htmlq >/dev/null 2>&1; then
  if [ "$pandoc_arch" = amd64 ]; then
    curl --fail --location --retry 3 -o "$temporary/htmlq.tar.gz" \
      https://github.com/mgdm/htmlq/releases/download/v0.4.0/htmlq-x86_64-linux.tar.gz
    tar -xzf "$temporary/htmlq.tar.gz" -C /usr/local/bin
  else
    # Upstream 0.4.0 has no Linux ARM64 release artifact; compile that version.
    apt-get install -y --no-install-recommends cargo gcc libc6-dev
    CARGO_HOME="$temporary/cargo" CARGO_TARGET_DIR="$temporary/target" \
      cargo install htmlq --version 0.4.0 --locked --root "$temporary/install" --jobs 1
    install -m 0755 "$temporary/install/bin/htmlq" /usr/local/bin/htmlq
  fi
fi
curl --fail --location --retry 3 -o "$temporary/pandoc.tar.gz" \
  "https://github.com/jgm/pandoc/releases/download/3.6.4/pandoc-3.6.4-linux-$pandoc_arch.tar.gz"
tar -xzf "$temporary/pandoc.tar.gz" --strip-components=2 -C /usr/local/bin pandoc-3.6.4/bin/pandoc
systemctl daemon-reload
touch /usr/local/lib/vektor/bootstrap-complete
`;

/** The SSH host key is pinned before first boot; application secrets are sent over SSH. */
export function cloudConfig(
  publicKey: string,
  hostPrivateKey: string,
  hostPublicKey: string,
): string {
  return `#cloud-config\n${JSON.stringify({
    ssh_pwauth: false,
    disable_root: true,
    users: [
      {
        name: "vektoradmin",
        groups: ["sudo"],
        sudo: ["ALL=(ALL) NOPASSWD:ALL"],
        shell: "/bin/bash",
        lock_passwd: true,
        ssh_authorized_keys: [publicKey.trim()],
      },
    ],
    ssh_keys: { ed25519_private: hostPrivateKey, ed25519_public: hostPublicKey.trim() },
    write_files: [
      {
        path: "/usr/local/sbin/vektor-data",
        permissions: "0700",
        content: prepareData,
      },
      {
        path: "/etc/systemd/system/vektor.service",
        permissions: "0644",
        content: service,
      },
      {
        path: "/usr/local/sbin/vektor-prepare",
        permissions: "0700",
        content: prepareGuest,
      },
    ],
  })}\n`;
}

export async function environment(file: string, domain: string): Promise<string> {
  const input: unknown = JSON.parse(await readFile(file, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("--env must contain a JSON object of environment variable strings.");
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(key) ||
      typeof value !== "string" ||
      /[\r\n\0]/.test(value)
    ) {
      throw new Error(`Invalid environment entry: ${key}`);
    }
    values[key] = value;
  }
  if (values.VEKTOR_DATABASE_URL || values.VEKTOR_S3_BUCKET) {
    throw new Error(
      "This host CLI requires local database and file storage so customer data is included in VM backups.",
    );
  }
  const hasAuth =
    values.VEKTOR_EMAIL_AUTH === "1" ||
    (values.GOOGLE_CLIENT_ID && values.GOOGLE_CLIENT_SECRET) ||
    (values.OAUTH_PROVIDER_ID && values.OAUTH_CLIENT_ID && values.OAUTH_CLIENT_SECRET);
  if (!hasAuth) {
    throw new Error("Configure OAuth, Google login, or VEKTOR_EMAIL_AUTH=1 in --env.");
  }
  if (!values.AUTH_SECRET) values.AUTH_SECRET = randomBytes(32).toString("base64");
  if (!values.VEKTOR_SECRETS_ENCRYPTION_KEY) {
    values.VEKTOR_SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  }
  if (values.AUTH_SECRET.length < 32)
    throw new Error("AUTH_SECRET must have at least 32 characters.");
  const encryptionKey = values.VEKTOR_SECRETS_ENCRYPTION_KEY;
  if (
    Buffer.from(encryptionKey, "base64").length !== 32 &&
    Buffer.byteLength(encryptionKey) !== 32
  ) {
    throw new Error("VEKTOR_SECRETS_ENCRYPTION_KEY must encode 32 bytes.");
  }
  Object.assign(values, {
    NODE_ENV: "production",
    HOST: "0.0.0.0",
    VEKTOR_SITE_URL: `https://${domain}`,
    VEKTOR_API_URL: `https://${domain}`,
    VEKTOR_COLLABORATION_HOST: domain,
    VEKTOR_DATA_DIR: "/var/lib/vektor",
    VEKTOR_NO_AUTH: "0",
    VEKTOR_IN_MEMORY_DB: "0",
    VEKTOR_TRUST_PROXY: "1",
    VEKTOR_JOB_FETCH_ALLOW_PRIVATE: "0",
  });
  // EnvironmentFile performs no variable expansion. Quote backslashes and quotes.
  return `${Object.entries(values)
    .map(
      ([key, value]) =>
        `${key}="${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`,
    )
    .join("\n")}\n`;
}

export const activateBinary = `set -eu
candidate=/usr/local/lib/vektor/candidate
test -x "$candidate"
"$candidate" __native-self-test
systemctl stop vektor.service
if [ -f /usr/local/bin/vektor ]; then
  cp /usr/local/bin/vektor /usr/local/lib/vektor/previous
fi
mv "$candidate" /usr/local/bin/vektor
systemctl enable vektor.service
systemctl start vektor.service
`;
