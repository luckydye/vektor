import { config } from "../config.ts";

// Batching and debouncing for sync events
const pendingScopes = new Set<string>();
let debounceTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_DELAY = 100; // milliseconds

async function flushSyncEvents() {
  if (pendingScopes.size === 0) return;

  const appConfig = config();

  try {
    await fetch(
      `http${import.meta.env.DEV ? "" : "s"}://${appConfig.COLLABORATION_HOST}/sync`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify([...pendingScopes]),
      },
    );

    pendingScopes.clear();
  } catch (err) {
    console.warn("Failed to send sync events:", err);
  }
}

export async function sendSyncEvent(scope: string) {
  pendingScopes.add(scope);

  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }

  debounceTimer = setTimeout(() => {
    flushSyncEvents();
    debounceTimer = null;
  }, DEBOUNCE_DELAY);
}
