import { createSignal, Show } from "solid-js";
import { useRemoteScreen } from "#composeables/useRemoteScreen.ts";
import { Icon } from "./Icon.tsx";

/** A remote agent's live screen as a call tile; clicking it hands mouse and keyboard to the remote machine. */
export function RemoteScreen(props: {
  screen: { spaceId: string; sessionId: string; runner: string };
  task: string;
}) {
  let canvas: HTMLCanvasElement | undefined;
  const [focused, setFocused] = createSignal(false);
  const [hasFrame, setHasFrame] = createSignal(false);
  const remote = useRemoteScreen(props.screen, (frame) => {
    if (canvas) {
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      canvas.getContext("2d")?.drawImage(frame, 0, 0);
      setHasFrame(true);
    }
    frame.close();
  });

  function pointer(
    type: "move" | "down" | "up" | "wheel",
    event: MouseEvent,
    detail: number,
  ) {
    const element = event.currentTarget as HTMLCanvasElement;
    const rect = element.getBoundingClientRect();
    // The canvas is letterboxed (object-contain), so map onto the picture, not the box.
    const scale = Math.min(rect.width / element.width, rect.height / element.height);
    const width = element.width * scale;
    const height = element.height * scale;
    const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
    const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
    remote.pointer(type, Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)), detail);
  }

  function key(event: KeyboardEvent) {
    if (remote.key(event)) event.preventDefault();
  }

  return (
    <div
      class="relative flex h-full min-h-0 min-w-0 overflow-hidden rounded-lg bg-black"
      classList={{
        "ring-1 ring-neutral-500/20": !focused(),
        "ring-1 ring-neutral-400/50 ring-inset": focused(),
      }}
    >
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label={`Screen of ${props.screen.runner}`}
        class="block h-full w-full cursor-default bg-black object-contain outline-none"
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          remote.releaseKeys();
        }}
        onMouseMove={(event) => pointer("move", event, 0)}
        onMouseDown={(event) => pointer("down", event, event.button)}
        onMouseUp={(event) => pointer("up", event, event.button)}
        onContextMenu={(event) => event.preventDefault()}
        on:wheel={{
          passive: false,
          handleEvent(event: WheelEvent) {
            event.preventDefault();
            pointer("wheel", event, event.deltaY);
          },
        }}
        onKeyDown={key}
        onKeyUp={key}
      />

      <Show when={remote.state() === "connecting" || (remote.state() === "ended" && !hasFrame())}>
        <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 px-4 text-center">
          <Show
            when={remote.state() === "connecting"}
            fallback={
              <p class="text-size-small text-white/70">
                {remote.error() ?? "The screen has ended."}
              </p>
            }
          >
            <Icon class="h-5 w-5 animate-spin text-white/60" name="spinner" />
            <p class="text-size-small text-white/70">
              Connecting to {props.screen.runner}…
            </p>
          </Show>
        </div>
      </Show>

      <div class="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-linear-to-t from-black/85 via-black/35 to-transparent px-3 pt-8 pb-2">
        <div class="min-w-0">
          <div class="flex items-center gap-1.5">
            <span
              class="h-1.5 w-1.5 shrink-0 rounded-full"
              classList={{
                "bg-green-500": remote.state() === "live",
                "animate-pulse bg-amber-400": remote.state() === "connecting",
                "bg-neutral-500": remote.state() === "ended",
              }}
            />
            <span class="truncate font-medium text-size-small text-white">
              {props.screen.runner}
            </span>
            <Show when={remote.state() === "ended"}>
              <span class="shrink-0 text-size-extra-small text-white/40">ended</span>
            </Show>
          </div>
          <p class="truncate text-size-extra-small text-white/60">{props.task}</p>
        </div>
        <Show when={remote.state() === "live"}>
          <button
            type="button"
            class="pointer-events-auto shrink-0 rounded-full bg-white/15 px-2.5 py-1 font-medium text-size-extra-small text-white transition-colors hover:bg-white/25"
            onClick={remote.toggleSound}
          >
            {remote.sound() ? "Mute" : "Sound"}
          </button>
        </Show>
      </div>
    </div>
  );
}
