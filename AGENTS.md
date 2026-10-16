## Tech Stack

- **Runtime:** Bun
- **Frontend:** Astro + SolidJS (`@solidjs/router`) + Tailwind CSS v4
- **Editor:** Tiptap (ProseMirror-based)
- **Canvas:** own WebGL2 renderer (`server/src/canvas`)
- **Spreadsheets:** IronCalc (wasm)
- **Collaboration:** Yjs + y-prosemirror
- **Backend:** Hono (API routes), better-auth (auth)
- **Database:** Drizzle ORM (SQLite via libsql)
- **Native modules:** Rust → `.node` via napi-rs (`server/native/`: image processing, JS runtime, local embeddings)
- **Tests:** Vitest (`server` + `frontend` projects, happy-dom), Playwright (e2e)
- **Linter/formatter:** Biome and TypeScript
- **Package manager:** Bun (monorepo workspace: `server/`)

## Repo Layout

- `server/` — the app (Astro frontend + Hono API), compiled into the single `vektor` binary
- `app/` — native desktop app (Rust)
- `api/` — API client package
- `extensions/` — first-party extensions

## General Guidelines

- Default exports are bad, only use named exports.
- Prefer to separate UI rendering from data handling. Data and logic should be provided to a UI component, not computed inside the component.
- Do not worry about backwards compatibility, unless requested otherwise.
- ALWAYS mark backwards compatible code paths or deprecated functions as deprecated when encountered.
- Unless the code is committed, feel free to completely change or refactor it, without backwards compatibility concerns.
- Staging / unstaged is controlled by humans, do not worry about or modify it. Also do not run any git commands unless prompted to.
- Important: Before implementing a "fix" or adding a new feature, ALWAYS look for a reason not to write new code. It may already exist in a similar form in the codebase.
- NEVER just run tests and checks after doing something, I tell you when we are done and should check the code.

## Type checking

`task check` (tsc + biome for `server/`)

## Running Tests

- `task test` — server suite; starts the compiled `./vektor` binary, so run `task compile` first
- `task test:frontend` — frontend component suite, no server needed
- `task test:e2e` — Playwright browser tests

Always run vitest as `bunx --bun vitest`, never `bun test`.

## Logs

`task dev` starts the dev server (`bun --watch ./src/server.ts`) and writes its stdout/stderr to `dev.log` in the repo root while the process is running. Read that file to inspect logs.
