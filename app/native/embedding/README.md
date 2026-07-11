# native/embedding

Rust N-API addon for Vektor's local search embeddings. It embeds the pinned
`Qdrant/bge-small-en-v1.5-onnx-Q` ONNX model (384 dimensions) and its tokenizer
in the addon, then runs model initialization and inference on N-API worker
threads, leaving Bun's event loop available for requests. It returns normalized
vectors; no model cache or runtime network access is used.

The build downloads the pinned model files from Hugging Face once, then compiles
them into the platform addon. The production binary therefore needs no model
download. `embeddedModelLicenses()` returns the Apache-2.0 and MIT texts that
are compiled into the addon.

```sh
bun i
bun run build
```

The build writes `embedding-<platform>-<arch>.node` and a static loader under
`app/src/embeddings/native/`, which Bun embeds into compiled Vektor binaries.
