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
  // The ranges the job runtime's own copy of this list let through.
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
    // The rest of 0.0.0.0/8, which the consolidation dropped.
    "0.0.0.1",
    "0.1.2.3",
    "::1",
    "::",
    "0:0:0:0:0:0:0:1",
    "fe80::1",
    "ff02::1",
    // Judged by the v4 rules, not the v6 CIDRs.
    "::ffff:127.0.0.1", // IPv4-mapped
    "::ffff:169.254.169.254",
    "::ffff:7f00:1",
    "::127.0.0.1", // IPv4-compatible
    "::ffff:0:127.0.0.1", // IPv4-translated
    "::ffff:0:7f00:1",
    "64:ff9b::127.0.0.1", // NAT64
    "64:ff9b::7f00:1",
    // Tunnels that do not say where they land.
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
    // The bypass that made the media proxy usable as an SSRF relay.
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

// A real upstream, for real 3xx responses rather than a stub. The second origin is
// the third party a chain ends up at, where credentials must not follow.
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

// A port nobody listens on: claimed, then released. Refused at once everywhere,
// unlike alias 127.0.0.2, which Linux refuses but macOS silently drops.
const vacant = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
const vacantPort = vacant.port;
vacant.stop(true);

// Loopback is what `resolvePublicUrl` exists to refuse, so the two test origins
// are allowed by name and everything else defers to the real policy.
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

  // `pinned.test` resolves nowhere, so the request can only arrive if the pin
  // chose the peer — and `Host` has to survive it, or virtual hosting breaks.
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

  // The unreachable record refuses on Linux and silently drops on macOS, so this
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
      // The same refusing address twice: the exhausted race is what is under test.
      addresses: ["127.0.0.1", "127.0.0.1"],
    });

    await expect(
      safeFetch(`http://pinned.test:${vacantPort}/host`, { method: "GET" }, pinToNothing),
    ).rejects.toThrow();
  });
});

// Both of these match native `fetch`, verified against it.
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

  // Otherwise a 302 to a CDN or pre-signed URL is handed the bearer token.
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

// `jobs.spec.ts` covers this end to end, but only with the workflow-builder
// artifact present. These exercise the policy itself.
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

  // Audit 012: the guard passed the public first hop, then `fetch` followed the 302.
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

  // `new URL("//evil.example/x", base)` is protocol-relative: `base` is discarded
  // and the request goes off-origin carrying the caller's OAuth token.
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
