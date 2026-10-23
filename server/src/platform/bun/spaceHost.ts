import { appLogger } from "#observability/logger.ts";
import type { Platform, SpaceHost } from "#platform/platform.ts";
import { runSpaceWork } from "#platform/spaceWork.ts";

/** Least time between two passes over one space, so work that stays due cannot spin. */
const MIN_PASS_GAP_MS = 5_000;
/** When a pass that failed outright is tried again. */
const RETRY_MS = 60_000;
/** The longest delay `setTimeout` takes; a later wake is reached in hops. */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface Wake {
  /** When the next pass is due, in ms; Infinity while none is. */
  at: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  lastPassAt: number;
}

/** One timer per space with pending work, in this process. */
export function createTimerSpaceHost(platform: () => Platform): SpaceHost {
  const wakes = new Map<string, Wake>();

  function arm(spaceId: string, wake: Wake): void {
    if (wake.timer) clearTimeout(wake.timer);
    const now = Date.now();
    const delay = Math.max(0, wake.at - now, wake.lastPassAt + MIN_PASS_GAP_MS - now);
    wake.timer = setTimeout(
      () => void pass(spaceId, wake),
      Math.min(delay, MAX_TIMER_MS),
    );
    wake.timer.unref?.();
  }

  async function pass(spaceId: string, wake: Wake): Promise<void> {
    wake.timer = null;
    if (wake.at > Date.now()) {
      arm(spaceId, wake);
      return;
    }

    // Wakes requested while the pass runs lower `at` again and are honoured after it.
    wake.running = true;
    wake.at = Number.POSITIVE_INFINITY;
    let next: number;
    try {
      next =
        (await runSpaceWork(platform(), spaceId, new Date()))?.getTime() ??
        Number.POSITIVE_INFINITY;
    } catch (error) {
      appLogger.error("Background pass failed for space", { spaceId, error });
      next = Date.now() + RETRY_MS;
    }
    wake.running = false;
    wake.lastPassAt = Date.now();
    wake.at = Math.min(wake.at, next);

    if (wake.at === Number.POSITIVE_INFINITY) wakes.delete(spaceId);
    else arm(spaceId, wake);
  }

  return {
    at(spaceId, time) {
      let wake = wakes.get(spaceId);
      if (!wake) {
        wake = {
          at: Number.POSITIVE_INFINITY,
          timer: null,
          running: false,
          lastPassAt: 0,
        };
        wakes.set(spaceId, wake);
      }
      if (time.getTime() >= wake.at) return;
      wake.at = time.getTime();
      if (!wake.running) arm(spaceId, wake);
    },
  };
}
