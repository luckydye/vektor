# native/exec

Rust N-API addon providing Vektor's embedded JavaScript runtime. It uses Boa
instead of the former WebAssembly QuickJS runtime and exposes synchronous
`js-exec` evaluation plus the step-driven workflow VM.

```sh
bun i
bun run build
```

The build writes `exec-<platform>-<arch>.node` and a static loader under
`app/src/exec/native/`. Bun embeds that loader and addon in compiled binaries.
