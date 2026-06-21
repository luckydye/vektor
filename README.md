# Vektor

A self-hosted documentation platform built for teams. Organize knowledge across multiple spaces, collaborate in real time with the richly customizable [tiptap](https://tiptap.dev/) editor, and deploy anywhere as a single binary with no external dependencies.

Authentication is handled by [better-auth](https://www.better-auth.com/) — plug in any OAuth2 provider or bring your own auth layer.

## Features

- **Real-time collaboration** — multiple users edit the same document simultaneously, changes appear instantly
- **Multiple spaces** — organize teams, projects, or topics into separate, personalized spaces
- **Rich editor** — powered by [tiptap](https://tiptap.dev/) with full formatting, embeds, and extensibility
- **Flexible auth** — connect any OAuth2 provider or implement a custom authentication system via [better-auth](https://www.better-auth.com/)
- **Single binary** — ships as one self-contained executable, no runtime or database setup required
- **Cross-platform** — runs on Linux (x86_64) and macOS (arm64)

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/luckydye/vektor/main/install.sh | sh
```

This downloads the latest binary from [GitHub Releases](https://github.com/luckydye/vektor/releases/latest) and installs it to `/usr/local/bin/vektor`.

To install to a custom directory:

```sh
curl -fsSL https://raw.githubusercontent.com/luckydye/vektor/main/install.sh | INSTALL_DIR=~/.local/bin sh
```
