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
  VEKTOR_DEFAULT_SPACE: "",
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
