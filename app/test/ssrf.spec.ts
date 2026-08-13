import { afterAll, describe, expect, it, vi } from "vitest";
import { buildIntegrationApiUrl } from "#api/routes/spaces/integration-proxy.ts";
import type { OAuthProviderConfiguration } from "#integrations/oauthProviders.ts";
import { assertEgressAllowed } from "#jobs/runtime/capabilities.ts";
import {
  isPrivateOrBlockedIp,
  resolvePublicUrl,
  SsrfError,
  safeFetch,
  type UrlValidator,
} from "#utils/ssrf.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The denylist
// ─────────────────────────────────────────────────────────────────────────────

describe("isPrivateOrBlockedIp", () => {
  // The job runtime used to carry its own copy of this list, which tested
  // `startsWith("fc")` — only half of fc00::/7 — and knew nothing about CGNAT,
  // multicast or reserved space. These are the ranges that copy let through.
  it.each([
    "fd00::1",
    "fd12:3456:789a::1",
    "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "fc00::1",
    "100.64.0.1",
    "100.127.255.254",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
  ])("blocks %s", (ip) => {
    expect(isPrivateOrBlockedIp(ip)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    // The rest of 0.0.0.0/8, which the runtime's own copy of the list did block.
    "0.0.0.1",
    "0.1.2.3",
    "::1",
    "::",
    "0:0:0:0:0:0:0:1",
    "fe80::1",
    "ff02::1",
    // Every prefix that carries an IPv4 address reaches the v4 internet, so all of
    // them have to be judged by the v4 rules rather than the v6 CIDRs.
    "::ffff:127.0.0.1", // IPv4-mapped
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "::127.0.0.1", // IPv4-compatible
    "::ffff:0:127.0.0.1", // IPv4-translated
    "::ffff:0:7f00:1",
    "64:ff9b::127.0.0.1", // NAT64
    "64:ff9b::7f00:1",
    // Tunnel and translation prefixes that do not say where they land: 6to4 via
    // whatever relay answers, local-use NAT64 via the site's own translator.
    "2002:7f00:1::1",
    "64:ff9b:1::1",
  ])("blocks %s", (ip) => {
    expect(isPrivateOrBlockedIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "99.64.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "::ffff:0:8.8.8.8",
    "64:ff9b::8.8.8.8",
  ])("allows %s", (ip) => {
    expect(isPrivateOrBlockedIp(ip)).toBe(false);
  });

  it("refuses anything that is not an IP at all", () => {
    expect(isPrivateOrBlockedIp("not-an-ip")).toBe(true);
    expect(isPrivateOrBlockedIp("")).toBe(true);
  });
});

describe("resolvePublicUrl", () => {
  it("reports nothing to pin for a literal-IP host", async () => {
    const validated = await resolvePublicUrl("http://93.184.216.34/media.mp3");
    expect(validated.url.hostname).toBe("93.184.216.34");
    expect(validated.addresses).toEqual([]);
  });

  it.each([
    "http://127.0.0.1:9099/secret",
    "http://localhost/secret",
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00::1]/secret",
    "http://[::ffff:127.0.0.1]/secret",
    "file:///etc/passwd",
  ])("refuses %s", async (url) => {
    await expect(resolvePublicUrl(url)).rejects.toBeInstanceOf(SsrfError);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Redirect hops
// ─────────────────────────────────────────────────────────────────────────────

describe("safeFetch redirects", () => {
  it("refuses a redirect into loopback instead of following it", async () => {
    // A public first hop that 302s to an internal address — the bypass that made
    // the media proxy and the job runtime usable as an SSRF relay.
    const calls: string[] = [];
    const stub = vi.spyOn(globalThis, "fetch").mockImplementation(((
      input: string | URL | Request,
    ) => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:9099/secret" },
        }),
      );
    }) as typeof fetch);

    try {
      await expect(
        safeFetch("http://93.184.216.34/preview", { method: "GET" }),
      ).rejects.toBeInstanceOf(SsrfError);
    } finally {
      stub.mockRestore();
    }

    // The first hop happened; the internal one never did.
    expect(calls).toEqual(["http://93.184.216.34/preview"]);
  });

  it("gives up after too many redirects", async () => {
    const stub = vi.spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://93.184.216.34/loop" },
        }),
      )) as typeof fetch);

    try {
      await expect(
        safeFetch("http://93.184.216.34/loop", { method: "GET" }),
      ).rejects.toThrow(/Too many redirects/);
    } finally {
      stub.mockRestore();
    }
  });
});

/** What the request looked like by the time it arrived. */
async function echoRequest(request: Request): Promise<Response> {
  return Response.json({
    method: request.method,
    authorization: request.headers.get("authorization"),
    cookie: request.headers.get("cookie"),
    contentType: request.headers.get("content-type"),
    body: await request.text(),
  });
}

// A real upstream, so the hop loop is exercised against real 3xx responses rather
// than a stub. A second origin stands in for the third party a redirect chain
// routinely ends up at — a CDN, a pre-signed URL — which is where credentials must
// not follow.
function serveTestOrigin(
  routes: (request: Request, pathname: string) => Response | null,
) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === "/echo") return echoRequest(request);
      if (pathname === "/host") {
        return new Response(request.headers.get("host") ?? "", { status: 200 });
      }
      return routes(request, pathname) ?? new Response("no", { status: 404 });
    },
  });
}

const partner = serveTestOrigin(() => null);
const partnerOrigin = `http://127.0.0.1:${partner.port}`;

const upstream = serveTestOrigin((_request, pathname) => {
  const redirects: Record<string, [number, string]> = {
    "/start": [302, "/end"],
    "/off-limits": [302, "http://127.0.0.1:9099/secret"],
    "/moved": [302, "/echo"],
    "/see-other": [303, "/echo"],
    "/keeps-method": [307, "/echo"],
    "/to-partner": [302, `${partnerOrigin}/echo`],
  };
  const redirect = redirects[pathname];
  if (redirect) {
    return new Response(null, {
      status: redirect[0],
      headers: { location: redirect[1] },
    });
  }
  if (pathname === "/end") return new Response("arrived", { status: 200 });
  return null;
});
const upstreamOrigin = `http://127.0.0.1:${upstream.port}`;

// A port nobody listens on: claimed, then released. Connecting there is refused
// at once on every platform, unlike an unconfigured loopback alias such as
// 127.0.0.2, which Linux refuses but macOS silently drops.
const vacant = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const vacantPort = vacant.port;
vacant.stop(true);

// The validator lets these two origins through — loopback is exactly what
// `resolvePublicUrl` exists to refuse — and defers to the real policy for
// everything else, which is what a redirect target hits.
const allowUpstream: UrlValidator = async (raw) => {
  const url = new URL(raw);
  if (url.origin === upstreamOrigin || url.origin === partnerOrigin) {
    return { url, addresses: [] };
  }
  return await resolvePublicUrl(raw);
};

afterAll(() => {
  upstream.stop(true);
  partner.stop(true);
});

describe("safeFetch against a real upstream", () => {
  it("follows an allowed redirect and reports the final URL", async () => {
    const response = await safeFetch(
      `${upstreamOrigin}/start`,
      { method: "GET" },
      allowUpstream,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("arrived");
    expect(response.url).toBe(`${upstreamOrigin}/end`);
    expect(response.redirected).toBe(true);
  });

  it("refuses a real redirect aimed at a private address", async () => {
    await expect(
      safeFetch(`${upstreamOrigin}/off-limits`, { method: "GET" }, allowUpstream),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it('hands the 3xx back untouched when the caller asks for redirect: "manual"', async () => {
    const response = await safeFetch(
      `${upstreamOrigin}/start`,
      { method: "GET", redirect: "manual" },
      allowUpstream,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/end");
  });

  it('refuses the redirect outright for redirect: "error"', async () => {
    await expect(
      safeFetch(
        `${upstreamOrigin}/start`,
        { method: "GET", redirect: "error" },
        allowUpstream,
      ),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  // The DNS-rebinding half of the fix: the socket has to go to the address the
  // validator checked, not to whatever a second lookup returns. `pinned.test`
  // resolves nowhere at all, so the request can only arrive if the pin is what
  // chose the peer — and the `Host` header has to survive it, or virtual hosting
  // would break for every real caller.
  it("connects to the validated address and keeps the original Host", async () => {
    const pinToUpstream: UrlValidator = async (raw) => ({
      url: new URL(raw),
      addresses: ["127.0.0.1"],
    });

    const response = await safeFetch(
      `http://pinned.test:${upstream.port}/host`,
      { method: "GET" },
      pinToUpstream,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`pinned.test:${upstream.port}`);
    expect(response.url).toBe(`http://pinned.test:${upstream.port}/host`);
  });

  // A dual-stack name on a single-stack host resolves to records that cannot be
  // reached. Pinning to the first one only would turn a working fetch into a hard
  // failure, so the records are raced and the reachable one wins — whether the
  // unreachable one refuses (Linux) or silently drops (macOS), which is why this
  // must not depend on getting an error back from it.
  it("uses the validated address that connects, not just the first", async () => {
    const pinToTwo: UrlValidator = async (raw) => ({
      url: new URL(raw),
      addresses: ["127.0.0.2", "127.0.0.1"],
    });

    const response = await safeFetch(
      `http://pinned.test:${upstream.port}/host`,
      { method: "GET" },
      pinToTwo,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`pinned.test:${upstream.port}`);
  });

  it("reports the transport error when no validated address connects", async () => {
    const pinToNothing: UrlValidator = async (raw) => ({
      url: new URL(raw),
      // The same refusing address twice: what is under test is the exhausted
      // race, and a black-holing address would only test the OS connect timeout.
      addresses: ["127.0.0.1", "127.0.0.1"],
    });

    await expect(
      safeFetch(`http://pinned.test:${vacantPort}/host`, { method: "GET" }, pinToNothing),
    ).rejects.toThrow();
  });
});

// Following a redirect by hand means reimplementing what `redirect: "follow"` did
// for free. Both of these are what native `fetch` does, verified against it.
describe("safeFetch redirect semantics", () => {
  it("keeps credentials on a same-origin redirect", async () => {
    const response = await safeFetch(
      `${upstreamOrigin}/moved`,
      {
        method: "GET",
        headers: { Authorization: "Bearer secret-token", Cookie: "session=1" },
      },
      allowUpstream,
    );
    expect(await response.json()).toMatchObject({
      authorization: "Bearer secret-token",
      cookie: "session=1",
    });
  });

  // The leak this guards: an API that 302s to a CDN or a pre-signed URL would
  // otherwise be handed the caller's bearer token.
  it("drops credentials when the redirect leaves the origin", async () => {
    const response = await safeFetch(
      `${upstreamOrigin}/to-partner`,
      {
        method: "GET",
        headers: { Authorization: "Bearer secret-token", Cookie: "session=1" },
      },
      allowUpstream,
    );
    expect(response.url).toBe(`${partnerOrigin}/echo`);
    expect(await response.json()).toMatchObject({
      authorization: null,
      cookie: null,
    });
  });

  it.each([
    ["302", "/moved"],
    ["303", "/see-other"],
  ])("turns a POST into a bodyless GET on %s", async (_status, path) => {
    const response = await safeFetch(
      `${upstreamOrigin}${path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charge: true }),
      },
      allowUpstream,
    );
    // Re-POSTing would repeat whatever side effect the first hop already had.
    expect(await response.json()).toMatchObject({
      method: "GET",
      body: "",
      contentType: null,
    });
  });

  it("preserves the method and body on 307", async () => {
    const response = await safeFetch(
      `${upstreamOrigin}/keeps-method`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ charge: true }),
      },
      allowUpstream,
    );
    expect(await response.json()).toMatchObject({
      method: "POST",
      body: JSON.stringify({ charge: true }),
      contentType: "application/json",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The job runtime's egress policy
// ─────────────────────────────────────────────────────────────────────────────

// `jobs.spec.ts` covers this end to end, but only where the workflow-builder
// extension artifact is present. These exercise the policy itself, including the
// ranges the runtime's own denylist copy used to miss.
describe("job egress policy", () => {
  it.each([
    ["http://127.0.0.1:8080/api/v1/spaces", "127.0.0.1"],
    ["http://169.254.169.254/latest/meta-data/", "169.254.169.254"],
    ["http://[fd00::1]/", "fd00::1"],
    ["http://100.64.0.1/", "100.64.0.1"],
    ["http://198.18.0.1/", "198.18.0.1"],
    // `URL` normalises the mapped form to hex; either spelling must be refused.
    ["http://[::ffff:127.0.0.1]/", "::ffff:7f00:1"],
  ])("refuses %s", async (url, address) => {
    // The wording matters: jobs.spec.ts asserts on "private address".
    await expect(assertEgressAllowed(url)).rejects.toThrow(
      `resolves to the private address ${address}`,
    );
  });

  it("refuses localhost and non-HTTP schemes", async () => {
    await expect(assertEgressAllowed("http://localhost:8080/")).rejects.toThrow(
      "is not reachable from a job",
    );
    await expect(assertEgressAllowed("http://api.localhost/")).rejects.toThrow(
      "is not reachable from a job",
    );
    await expect(assertEgressAllowed("file:///etc/passwd")).rejects.toThrow(
      "unsupported protocol",
    );
  });

  it("allows a public literal IP with nothing to pin", async () => {
    await expect(assertEgressAllowed("http://93.184.216.34/x")).resolves.toEqual({
      url: new URL("http://93.184.216.34/x"),
      addresses: [],
    });
  });

  // The bypass from audit 012: the guard passed on a public first hop and the
  // bare `fetch` then followed the 302 into the metadata endpoint.
  it("refuses a redirect from a public host into a private address", async () => {
    const stub = vi.spyOn(globalThis, "fetch").mockImplementation((() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/iam/" },
        }),
      )) as typeof fetch);

    try {
      await expect(
        safeFetch("http://93.184.216.34/x", { method: "GET" }, assertEgressAllowed),
      ).rejects.toThrow("resolves to the private address 169.254.169.254");
    } finally {
      stub.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The integration proxy's path resolution
// ─────────────────────────────────────────────────────────────────────────────

function providerConfig(instanceUrl: string): OAuthProviderConfiguration {
  return {
    id: "youtrack",
    label: "YouTrack",
    clientId: "id",
    clientSecret: "secret",
    scopes: ["YouTrack"],
    authorizationUrl: `${instanceUrl}/oauth/authorize`,
    tokenUrl: `${instanceUrl}/oauth/token`,
    userInfoUrl: `${instanceUrl}/api/users/me`,
    instanceUrl,
  };
}

describe("buildIntegrationApiUrl", () => {
  const youtrack = providerConfig("https://youtrack.example.com");
  const gitlab: OAuthProviderConfiguration = {
    ...providerConfig("https://gitlab.example.com"),
    id: "gitlab",
  };

  it("resolves a plain path against the configured origin", () => {
    expect(buildIntegrationApiUrl("youtrack", youtrack, "/api/issues").href).toBe(
      "https://youtrack.example.com/api/issues",
    );
    expect(buildIntegrationApiUrl("youtrack", youtrack, "api/issues").href).toBe(
      "https://youtrack.example.com/api/issues",
    );
    expect(buildIntegrationApiUrl("gitlab", gitlab, "/projects").href).toBe(
      "https://gitlab.example.com/api/v4/projects",
    );
  });

  // `new URL("//evil.example/x", base)` is protocol-relative: `base` is thrown
  // away and the request — carrying the caller's OAuth token — goes off-origin.
  it.each([
    "//evil.example/x",
    "/\\evil.example/x",
    "//evil.example",
    "/\t/evil.example/x",
    "/\n/evil.example/x",
    "https://evil.example/x",
    "http://evil.example/x",
  ])("refuses %j for every provider", (path) => {
    for (const [provider, config] of [
      ["youtrack", youtrack],
      ["gitlab", gitlab],
    ] as const) {
      let thrown: unknown;
      try {
        buildIntegrationApiUrl(provider, config, path);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${provider} accepted ${JSON.stringify(path)}`).toBeInstanceOf(
        Response,
      );
      expect((thrown as Response).status).toBe(400);
    }
  });

  it("still allows an absolute URL on the configured origin", () => {
    expect(
      buildIntegrationApiUrl(
        "youtrack",
        youtrack,
        "https://youtrack.example.com/api/issues",
      ).href,
    ).toBe("https://youtrack.example.com/api/issues");
  });
});
