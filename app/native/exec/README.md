# native/exec

Rust N-API addon providing Vektor's embedded JavaScript runtime, built on Boa.

Two entry points:

- `evalJsSync` — the synchronous context behind the `js-exec` CLI.
- `vmCreate`/`vmResolve`/`vmReject`/`vmDestroy` — the VM that runs extension jobs
  and workflow scripts. Each VM owns an OS thread (Boa's `Gc` is `!Send`, so the
  context is built on that thread and never leaves it), takes commands over a
  channel, and pushes events to JS through a threadsafe function. Guest code never
  runs on the JS thread, and an idle VM blocks rather than polling.

Guest code reaches the host through exactly one primitive,
`__hostCall(name, ...args) -> Promise`. Everything a job can do is built on it in
the JS prelude (`app/src/jobs/runtime/prelude.ts`), so capabilities are a TS
concern and this crate stays small and deny-by-default.

```sh
bun i
bun run build
```

The build writes `exec-<platform>-<arch>.node` and a static loader under
`app/src/exec/native/`. Bun embeds that loader and addon in compiled binaries.
