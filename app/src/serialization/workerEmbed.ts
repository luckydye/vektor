// @ts-nocheck — `#generated/serialization-worker.js` is produced by build.ts at
// compile time (see generateSerializationWorkerBundle) and does not exist during
// type-checking or dev. This module is only ever dynamically imported from the
// compiled-binary branch of pool.ts, so the missing-at-dev-time
// import never loads outside a standalone build.
//
// `with { type: "file" }` makes Bun embed the pre-bundled, self-contained worker
// into the executable and resolve this import to its runtime ($bunfs) path — the
// same mechanism used for embedded client assets.
import serializationWorkerPath from "#generated/serialization-worker.js" with {
  type: "file",
};

export { serializationWorkerPath };
