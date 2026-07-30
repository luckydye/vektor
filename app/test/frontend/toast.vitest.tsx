import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ToastContainer from "#components/ToastContainer.vue";
import { useToast } from "#composeables/useToast.ts";
import { cleanupAll, render } from "./render.ts";

/**
 * The one behavioural test the transition work needs (plan section 5.3).
 *
 * The animation is decorative and deliberately untested. The *removal* is not:
 * `animation.finished` rejects when an animation is cancelled, and if that
 * rejection escapes, the toast stays on screen forever. These assert the toast
 * always leaves, whatever the animation does — including when there is no
 * animation at all, which is exactly the case happy-dom gives us for free since
 * it implements no `element.animate`.
 */

function toastNodes(): Element[] {
  return [...document.body.querySelectorAll("#toast-container > div")];
}

async function settle(ms = 0) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

let toast: ReturnType<typeof useToast>;

beforeEach(async () => {
  toast = useToast();
  for (const t of [...toast.toasts.value]) toast.drop(t.id);
  render(ToastContainer, {});
  await settle();
});

afterEach(() => {
  for (const t of [...toast.toasts.value]) toast.drop(t.id);
  cleanupAll();
});

describe("toast removal", () => {
  it("shows a toast and teleports it to the body", async () => {
    toast.show("Saved", "success", 0);
    await settle();
    expect(toastNodes()).toHaveLength(1);
    expect(document.body.textContent).toContain("Saved");
  });

  it("removes a dismissed toast even with no animation available", async () => {
    // happy-dom has no `element.animate`, so `animateOut` returns immediately —
    // the "reduced motion / unsupported" path, which must still reach `drop`.
    const id = toast.show("Gone soon", "info", 0);
    await settle();
    expect(toastNodes()).toHaveLength(1);

    toast.dismiss(id);
    await settle(50);
    expect(toastNodes()).toHaveLength(0);
  });

  it("removes a toast when its own timer expires", async () => {
    vi.useFakeTimers();
    try {
      toast.show("Auto", "info", 1000);
      await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();
      await settle(50);
      expect(toastNodes()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes every toast when several overlap", async () => {
    const ids = [
      toast.show("One", "info", 0),
      toast.show("Two", "info", 0),
      toast.show("Three", "info", 0),
    ];
    await settle();
    expect(toastNodes()).toHaveLength(3);

    // Dismissed in the same tick: the case a document-scoped transition could
    // not serve, and why this uses per-element animation instead.
    for (const id of ids) toast.dismiss(id);
    await settle(50);
    expect(toastNodes()).toHaveLength(0);
  });

  it("survives a double dismiss without stranding the toast", async () => {
    const id = toast.show("Twice", "info", 0);
    await settle();
    toast.dismiss(id);
    toast.dismiss(id);
    await settle(50);
    expect(toastNodes()).toHaveLength(0);
  });

  it("removes the toast when the leave animation is cancelled", async () => {
    // happy-dom implements no `element.animate`, so without this stub the
    // suite only ever exercises the no-animation path. This is the case
    // section 5.3 singles out: `animation.finished` *rejects* on cancellation,
    // and an uncaught rejection leaves the toast on screen forever.
    const animate = vi.fn(() => {
      const finished = Promise.reject(new Error("cancelled"));
      // Real WAAPI only creates this promise when `.finished` is read, so it
      // is never unhandled. The stub has to build it eagerly, hence the no-op
      // handler — awaiting it still rejects, which is what we are testing.
      finished.catch(() => {});
      return { finished, cancel() {} };
    });
    (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;

    try {
      const id = toast.show("Cancelled", "info", 0);
      await settle();
      expect(toastNodes()).toHaveLength(1);

      toast.dismiss(id);
      await settle(50);
      expect(animate).toHaveBeenCalled();
      expect(toastNodes()).toHaveLength(0);
    } finally {
      (HTMLElement.prototype as unknown as { animate?: unknown }).animate = undefined;
    }
  });

  it("drops immediately when asked to skip the animation", async () => {
    const id = toast.show("Replaced", "info", 0);
    await settle();
    toast.remove(id);
    await settle();
    expect(toastNodes()).toHaveLength(0);
  });
});
