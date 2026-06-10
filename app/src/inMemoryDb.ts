import { config } from "./config.ts";

export function isInMemoryDb(): boolean {
  return config().IN_MEMORY_DB === "1";
}

// In-memory DB mode keeps all data in RAM and discards it on restart.
// It must never be enabled in production — fail fast at startup.
if (isInMemoryDb()) {
  if (config().NODE_ENV === "production") {
    throw new Error(
      "VEKTOR_IN_MEMORY_DB=1 (in-memory database mode) cannot be used with NODE_ENV=production",
    );
  }
}
