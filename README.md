# Vektor

A simple self-hosted documentation platform built for teams. Organize knowledge across multiple spaces, collaborate in real time and deploy anywhere as a single binary with no external dependencies.

Collaboration software has drifted toward centralized clouds, where your knowledge lives on someone else's servers, behind someone else's terms, priced per seat and locked behind an account. Vektor aims to be the alternative: a single binary you can deploy in minutes and fully own, that works offline, keeps access control clear and central, and stays open source and free to use. Your content should live on infrastructure you control.

And it should do this without asking you to settle. Real-time, multiplayer editing that feels as good as the hosted tools, wrapped in something trivial to stand up alone and just as easy to share with others. Because owning your data should never mean choosing between staying in control and actually enjoying the tools you use every day.


## Features

- **Real-time collaboration** — multiple users edit the same document simultaneously, changes appear instantly
- **Multiple spaces** — organize teams, projects, or topics into separate, personalized spaces
- **Rich editor** — powered by [tiptap](https://tiptap.dev/) with full formatting, embeds, and extensibility
- **Flexible auth** — connect any OAuth2 provider or implement a custom authentication system via [better-auth](https://www.better-auth.com/)
- **Single binary** — ships as one self-contained executable, no runtime or database setup required

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/luckydye/vektor/main/install.sh | sh
```

This downloads the latest binary from [GitHub Releases](https://github.com/luckydye/vektor/releases/latest) and installs it to `/usr/local/bin/vektor`.

To install to a custom directory:

```sh
curl -fsSL https://raw.githubusercontent.com/luckydye/vektor/main/install.sh | INSTALL_DIR=~/.local/bin sh
```
