## Tech Stack

- **Runtime:** Bun
- **Frontend:** Astro + Vue 3 + Tailwind CSS v4
- **Editor:** Tiptap (ProseMirror-based), CodeMirror 6
- **Collaboration:** Yjs + y-prosemirror
- **Backend:** Hono (API routes), better-auth (auth)
- **Database:** Drizzle ORM (SQLite)
- **Native modules:** Rust → `.node` via napi-rs (image processing, JS runtime)
- **Observability:** OpenTelemetry (traces, metrics, logs via OTLP)
- **Linter/formatter:** Biome and Typescript
- **Package manager:** Bun (monorepo: `app/` workspace)

## General Guidelines

- Default exports are bad, only use named exports.
- Prefere to seperate UI rendering from data handling. Data and logic should be provided to a UI component, not computed inside the component.
- Do not worry about backwards compatibility, unless requested otherwise.
- ALWAYS mark backwards compatible code paths or depricated functions as deprecated when encountered
- Do NOT include backwards compatibility comments or code for code that has not been committed yet!
- Important: Before implementing a "fix" or adding a new feature, ALWAYS look for a reason not to write new code. It may already exist in a similar from in the codebase.
- NEVER just run tests and checks after doing something, I tell you when we are done and should check the code.

## Type checking

`task check`

## Running Tests

`task test`

## Logs

`task dev` starts the dev server (`bun --watch ./src/server.ts`) and writes its stdout/stderr to `dev.log` in the repo root while the process is running. Read that file to inspect logs.
