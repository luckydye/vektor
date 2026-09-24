/**
 * Environment setup for the frontend suite, run before every spec file.
 *
 * Astro injects a `<script id="env">` carrying the public runtime config, and
 * `#config` throws without it — so any component that transitively imports the
 * API client (most of them) cannot render in a bare happy-dom document. This
 * stands in for that script rather than mocking `#config`, so the specs
 * exercise the same code path the browser does.
 */
const PUBLIC_ENV = {
  VEKTOR_SITE_URL: "http://localhost",
  VEKTOR_API_URL: "http://localhost",
  VEKTOR_COLLABORATION_HOST: "localhost",
  VEKTOR_NO_AUTH: "1",
};

if (!document.getElementById("env")) {
  const script = document.createElement("script");
  script.id = "env";
  script.type = "application/json";
  script.textContent = JSON.stringify(PUBLIC_ENV);
  document.head.append(script);
}

/**
 * No spec may reach the network.
 *
 * Several components fetch on mount, and an unstubbed `fetch` makes the suite
 * slow, order-dependent, and noisy — happy-dom aborts the in-flight request at
 * teardown and prints an `AbortError` for each one. Tier 1 asserts on
 * props-driven DOM, so an empty successful response is the right default: the
 * component takes its "loaded, nothing here" path rather than an error path.
 *
 * A spec that needs a specific payload should stub `fetch` itself.
 */
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === "string" ? input : String((input as Request).url ?? input);
  return new Response(
    JSON.stringify(url.includes("documents") ? { documents: [] } : {}),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}) as typeof fetch;

/**
 * No spec may open a realtime socket.
 *
 * The API client connects on mount for live updates. happy-dom's `WebSocket`
 * delegates to the `ws` package, which refuses to run in a browser context, so
 * every route render threw an unhandled error. This inert stand-in never
 * connects and never fires — realtime behaviour is out of scope for a DOM
 * snapshot, and a spec that wants it can dispatch on the instance itself.
 */
class InertWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly readyState = InertWebSocket.CLOSED;
  readonly url: string;
  onopen: unknown = null;
  onclose: unknown = null;
  onerror: unknown = null;
  onmessage: unknown = null;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
  }
  send(): void {}
  close(): void {}
}
globalThis.WebSocket = InertWebSocket as unknown as typeof WebSocket;
