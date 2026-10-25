import { createSignal, onCleanup } from "solid-js";
import type { ScreenInputEvent } from "#agent/nodes/protocol.ts";

/** How far ahead of the speakers audio is queued, which absorbs network jitter. */
const AUDIO_LATENCY = 0.08;
/** Audio further ahead is dropped, so the delay cannot grow when clocks drift. */
const AUDIO_MAX_AHEAD = 0.3;
const MEDIA_KIND = { VIDEO: 0, AUDIO: 1 };
/** Linux evdev button codes for MouseEvent.button 0, 1 and 2. */
const BUTTONS = [0x110, 0x112, 0x111];

/** Linux evdev codes for KeyboardEvent.code. */
const KEY_CODES: Record<string, number> = {
  Escape: 1,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F11: 87,
  F12: 88,
  ControlRight: 97,
  AltRight: 100,
  Home: 102,
  ArrowUp: 103,
  PageUp: 104,
  ArrowLeft: 105,
  ArrowRight: 106,
  End: 107,
  ArrowDown: 108,
  PageDown: 109,
  Insert: 110,
  Delete: 111,
  MetaLeft: 125,
  MetaRight: 126,
};
[..."1234567890"].forEach((digit, index) => {
  KEY_CODES[`Digit${digit}`] = 2 + index;
});
for (const [row, first] of [
  ["QWERTYUIOP", 16],
  ["ASDFGHJKL", 30],
  ["ZXCVBNM", 44],
] as const) {
  [...row].forEach((letter, index) => {
    KEY_CODES[`Key${letter}`] = first + index;
  });
}
for (let index = 1; index <= 10; index++) KEY_CODES[`F${index}`] = 58 + index;

type Media =
  | {
      kind: "video";
      width: number;
      height: number;
      keyframe: boolean;
      data: Uint8Array<ArrayBuffer>;
    }
  | { kind: "audio"; data: Uint8Array<ArrayBuffer> };

/** Splits the manager's `stream` output into messages; returns them and the unparsed rest. */
function parseMedia(buffer: Uint8Array<ArrayBuffer>): {
  media: Media[];
  rest: Uint8Array<ArrayBuffer>;
} {
  const media: Media[] = [];
  let at = 0;
  while (at < buffer.length) {
    const view = new DataView(buffer.buffer, buffer.byteOffset + at);
    const kind = buffer[at];
    if (kind === MEDIA_KIND.AUDIO) {
      if (buffer.length - at < 5) break;
      const end = at + 5 + view.getUint32(1, true);
      if (buffer.length < end) break;
      media.push({ kind: "audio", data: buffer.slice(at + 5, end) });
      at = end;
    } else if (kind === MEDIA_KIND.VIDEO) {
      if (buffer.length - at < 14) break;
      const end = at + 14 + view.getUint32(10, true);
      if (buffer.length < end) break;
      media.push({
        kind: "video",
        width: view.getUint32(1, true),
        height: view.getUint32(5, true),
        keyframe: buffer[at + 9] === 1,
        data: buffer.slice(at + 14, end),
      });
      at = end;
    } else {
      throw new Error(`Unknown screen media kind ${kind}.`);
    }
  }
  return { media, rest: buffer.slice(at) };
}

/** The codec string of an Annex B keyframe, from its sequence parameter set. */
function h264Codec(data: Uint8Array): string {
  for (let i = 0; i + 6 < data.length; i++) {
    if (
      data[i] === 0 &&
      data[i + 1] === 0 &&
      data[i + 2] === 1 &&
      (data[i + 3] & 0x1f) === 7
    ) {
      const profile = [...data.subarray(i + 4, i + 7)];
      return `avc1.${profile.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  throw new Error("H.264 keyframe without a sequence parameter set.");
}

/**
 * Watches and drives a remote sub-agent's screen: H.264 decoded to
 * `VideoFrame`s for `draw`, which must close them, Opus to the speakers once
 * sound is on, and mouse and keyboard sent back as evdev events.
 */
export function useRemoteScreen(
  screen: { spaceId: string; taskId: string },
  draw: (frame: VideoFrame) => void,
) {
  const [state, setState] = createSignal<"connecting" | "live" | "ended">("connecting");
  const [error, setError] = createSignal<string | null>(null);
  const [sound, setSound] = createSignal(false);
  /** The remote display's size in pixels, which pointer positions scale to. */
  let size = { width: 0, height: 0 };
  let pending = new Uint8Array(0);
  const held = new Set<number>();
  let queued: ScreenInputEvent[] = [];
  let flushFrame: number | null = null;
  let playback: AudioContext | null = null;
  let playAt = 0;

  const socket = new WebSocket(
    `${location.origin.replace(/^http/, "ws")}/screens/${encodeURIComponent(screen.spaceId)}/${encodeURIComponent(screen.taskId)}`,
  );
  socket.binaryType = "arraybuffer";

  const fail = (reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
    socket.close();
  };

  const video = new VideoDecoder({ output: draw, error: fail });
  const audio = new AudioDecoder({
    output(decoded) {
      if (playback && playAt - playback.currentTime <= AUDIO_MAX_AHEAD) {
        const buffer = playback.createBuffer(
          decoded.numberOfChannels,
          decoded.numberOfFrames,
          decoded.sampleRate,
        );
        for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
          decoded.copyTo(buffer.getChannelData(channel), {
            planeIndex: channel,
            format: "f32-planar",
          });
        }
        const source = playback.createBufferSource();
        source.buffer = buffer;
        source.connect(playback.destination);
        playAt = Math.max(playAt, playback.currentTime + AUDIO_LATENCY);
        source.start(playAt);
        playAt += buffer.duration;
      }
      decoded.close();
    },
    error: fail,
  });
  audio.configure({ codec: "opus", sampleRate: 48000, numberOfChannels: 2 });

  let timestamp = 0;
  socket.onmessage = (event) => {
    if (typeof event.data === "string") {
      // The server's keep-alive; answering it is what keeps a passive viewer connected.
      socket.send(JSON.stringify({ type: "ping" }));
      return;
    }
    setState("live");
    const chunk = new Uint8Array(event.data as ArrayBuffer);
    const joined = new Uint8Array(pending.length + chunk.length);
    joined.set(pending);
    joined.set(chunk, pending.length);
    try {
      const parsed = parseMedia(joined);
      pending = parsed.rest;
      for (const media of parsed.media) {
        timestamp++;
        if (media.kind === "audio") {
          if (sound())
            audio.decode(
              new EncodedAudioChunk({ type: "key", timestamp, data: media.data }),
            );
          continue;
        }
        size = { width: media.width, height: media.height };
        if (media.keyframe) {
          video.configure({
            codec: h264Codec(media.data),
            optimizeForLatency: true,
            hardwareAcceleration: "prefer-hardware",
          });
        }
        if (video.state === "configured") {
          video.decode(
            new EncodedVideoChunk({
              type: media.keyframe ? "key" : "delta",
              timestamp,
              data: media.data,
            }),
          );
        }
      }
    } catch (reason) {
      fail(reason);
    }
  };
  socket.onclose = (event) => {
    setState("ended");
    if (event.code !== 1000 && !error()) {
      setError(event.reason || `The screen closed (${event.code}).`);
    }
  };

  function send(events: ScreenInputEvent[]) {
    if (state() !== "live") return;
    queued.push(...events);
    // Pointer moves come faster than frames; one message per frame carries them.
    flushFrame ??= requestAnimationFrame(() => {
      flushFrame = null;
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", events: queued }));
      }
      queued = [];
    });
  }

  /** `x` and `y` are fractions of the displayed screen; `detail` is the button or wheel delta. */
  function pointer(
    type: "move" | "down" | "up" | "wheel",
    x: number,
    y: number,
    detail = 0,
  ) {
    const move = {
      move: { x: Math.floor(x * size.width), y: Math.floor(y * size.height) },
    };
    if (type === "move") send([move]);
    else if (type === "wheel") {
      send([move, { scroll: { value: -Math.sign(detail), horizontal: false } }]);
    } else if (BUTTONS[detail] !== undefined) {
      send([move, { button: { button: BUTTONS[detail], down: type === "down" } }]);
    }
  }

  /** Returns whether the key went to the screen, so the page should not act on it. */
  function key(event: KeyboardEvent): boolean {
    const code = KEY_CODES[event.code];
    if (code === undefined) return false;
    // The remote side repeats held keys itself.
    if (event.repeat) return true;
    const down = event.type === "keydown";
    if (down) held.add(code);
    else held.delete(code);
    send([{ key: { code, down } }]);
    return true;
  }

  /** Lets go of every held key, e.g. when focus leaves the screen mid-shortcut. */
  function releaseKeys() {
    send([...held].map((code) => ({ key: { code, down: false } })));
    held.clear();
  }

  /** Must run in a user gesture, which browsers require before playing sound. */
  function toggleSound() {
    playback ??= new AudioContext();
    void playback.resume();
    setSound(!sound());
  }

  onCleanup(() => {
    if (flushFrame !== null) cancelAnimationFrame(flushFrame);
    socket.close();
    if (video.state !== "closed") video.close();
    if (audio.state !== "closed") audio.close();
    void playback?.close();
  });

  return { state, error, sound, pointer, key, releaseKeys, toggleSound };
}
