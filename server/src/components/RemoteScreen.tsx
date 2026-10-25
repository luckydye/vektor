import { createSignal, Show } from "solid-js";
import { useRemoteScreen } from "#composeables/useRemoteScreen.ts";

/** A remote sub-agent's live screen; clicking it hands mouse and keyboard to the remote machine. */
export function RemoteScreen(props: {
  screen: { spaceId: string; taskId: string; node: string };
  task: string;
}) {
  let canvas: HTMLCanvasElement | undefined;
  const [focused, setFocused] = createSignal(false);
  const remote = useRemoteScreen(props.screen, (frame) => {
    if (canvas) {
      if (canvas.width !== frame.displayWidth) canvas.width = frame.displayWidth;
      if (canvas.height !== frame.displayHeight) canvas.height = frame.displayHeight;
      canvas.getContext("2d")?.drawImage(frame, 0, 0);
    }
    frame.close();
  });

  function pointer(
    type: "move" | "down" | "up" | "wheel",
    event: MouseEvent,
    detail: number,
  ) {
    const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    remote.pointer(
      type,
      (event.clientX - rect.left) / rect.width,
      (event.clientY - rect.top) / rect.height,
      detail,
    );
  }

  function key(event: KeyboardEvent) {
    if (remote.key(event)) event.preventDefault();
  }

  return (
    <div class="min-w-0 flex-1 overflow-hidden rounded-lg border border-neutral-200">
      <div class="flex items-center gap-2 px-3 py-1.5 text-size-small">
        <span class="shrink-0 font-medium text-neutral-800">{props.screen.node}</span>
        <span class="min-w-0 flex-1 truncate text-neutral-500">{props.task}</span>
        <Show when={remote.state() === "live"}>
          <button
            type="button"
            class="shrink-0 text-neutral-500 hover:text-neutral-800"
            onClick={remote.toggleSound}
          >
            {remote.sound() ? "Mute" : "Sound"}
          </button>
        </Show>
      </div>
      <Show
        when={remote.state() !== "ended"}
        fallback={
          <div class="border-neutral-200 border-t px-3 py-2 text-neutral-500 text-size-small">
            {remote.error() ?? "The screen has ended."}
          </div>
        }
      >
        <canvas
          ref={canvas}
          tabIndex={0}
          aria-label={`Screen of ${props.screen.node}`}
          class="block h-auto w-full cursor-default bg-black outline-none"
          classList={{ "ring-2 ring-primary-500 ring-inset": focused() }}
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
      </Show>
    </div>
  );
}
