# Tech Stack

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

# Type checking

`task check`

# RUnning Tests

`task test`