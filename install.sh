#!/usr/bin/env sh
set -e

REPO="luckydye/vektor"
BIN_NAME="vektor"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

# Detect OS
OS="$(uname -s)"
case "$OS" in
  Linux)  os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

# Detect architecture
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)          arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

ASSET="${BIN_NAME}-${os}-${arch}"

# Bun's default x64 runtime is built for Haswell and dies with SIGILL on a CPU
# without AVX2, which is what a VM pinned to a generic model reports.
if [ "$os" = "linux" ] && [ "$arch" = "x64" ] && ! grep -qw avx2 /proc/cpuinfo 2>/dev/null; then
  echo "No AVX2 on this CPU, using the baseline build."
  ASSET="${ASSET}-baseline"
fi

URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

echo "Downloading $ASSET..."
curl -fSL "$URL" -o "/tmp/${BIN_NAME}"
chmod +x "/tmp/${BIN_NAME}"

echo "Installing to ${INSTALL_DIR}/${BIN_NAME}..."
if [ -w "$INSTALL_DIR" ]; then
  mv "/tmp/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}"
else
  sudo mv "/tmp/${BIN_NAME}" "${INSTALL_DIR}/${BIN_NAME}"
fi

echo "Done. Run 'vektor --help' to get started."
