# Vektor

This is a proof-of-concept enterprise grade project documentation tool based on text documents, with minimal dependencies.

Supports multiple spaces, space personalization, and real-time collaboration within the powerful and customizable [tiptap](https://tiptap.dev/) editor.
Authenticate over generic OAuth2 or implement your own authentication system with [better-auth](https://www.better-auth.com/).

## Install

Supports Linux (x86_64) and macOS (arm64).

```sh
curl -fsSL https://raw.githubusercontent.com/luckydye/vektor/main/install.sh | sh
```

This downloads the latest binary from [GitHub Releases](https://github.com/luckydye/vektor/releases/latest) and installs it to `/usr/local/bin/vektor`.

To install to a custom directory:

```sh
curl -fsSL https://raw.githubusercontent.com/luckydye/vektor/main/install.sh | INSTALL_DIR=~/.local/bin sh
```
