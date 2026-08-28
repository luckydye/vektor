/**
 * OAuth providers now come from extension manifests, so the two things worth
 * pinning are what the manifest validator refuses to install and how a
 * declaration plus operator env resolves into a usable provider config.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionIntegration } from "#extensions/manifest.ts";
import { extractManifest } from "#extensions/manifest.ts";
import {
  fetchOAuthExternalUser,
  type OAuthProviderDefinition,
  resolveOAuthProviderConfiguration,
} from "#integrations/oauthProviders.ts";
import { createZipBuffer } from "#utils/zip.ts";

const gitlabIntegration: ExtensionIntegration = {
  id: "gitlab",
  label: "GitLab",
  authorizationUrl: "{instance}/oauth/authorize",
  tokenUrl: "{instance}/oauth/token",
  userInfoUrl: "{instance}/api/v4/user",
  scopes: ["api"],
  defaultInstanceUrl: "https://gitlab.com",
  apiBasePath: "/api/v4",
  profile: { accountId: ["id"], username: ["username", "name"] },
};

function definition(
  integration: ExtensionIntegration = gitlabIntegration,
): OAuthProviderDefinition {
  return { extensionId: "gitlab", integration };
}

function packageWith(manifest: Record<string, unknown>): Buffer {
  return createZipBuffer([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "dist/job.js", data: Buffer.from("output({})") },
  ]);
}

const baseManifest = {
  id: "gitlab",
  name: "GitLab",
  version: "1.0.0",
  entries: {},
};

describe("integration manifests", () => {
  it("accepts a complete declaration", () => {
    const manifest = extractManifest(
      packageWith({ ...baseManifest, integrations: [gitlabIntegration] }),
    );
    expect(manifest.integrations?.[0]?.id).toBe("gitlab");
  });

  it.each([
    ["a non-slug id", { ...gitlabIntegration, id: "Git Lab" }],
    ["a missing label", { ...gitlabIntegration, label: "" }],
    ["a missing token endpoint", { ...gitlabIntegration, tokenUrl: "" }],
    ["no profile mapping", { ...gitlabIntegration, profile: { accountId: [] } }],
  ])("refuses %s", (_case, integration) => {
    expect(() =>
      extractManifest(packageWith({ ...baseManifest, integrations: [integration] })),
    ).toThrow();
  });

  it("refuses an agent command naming a job that does not exist", () => {
    expect(() =>
      extractManifest(
        packageWith({
          ...baseManifest,
          integrations: [
            {
              ...gitlabIntegration,
              agent: { command: { name: "gitlab", jobId: "missing" } },
            },
          ],
        }),
      ),
    ).toThrow(/missing/);
  });

  it("accepts an agent command backed by a declared job", () => {
    const manifest = extractManifest(
      packageWith({
        ...baseManifest,
        jobs: [{ id: "gitlab-command", name: "Command", entry: "dist/job.js" }],
        integrations: [
          {
            ...gitlabIntegration,
            agent: { command: { name: "gitlab", jobId: "gitlab-command" } },
          },
        ],
      }),
    );
    expect(manifest.integrations?.[0]?.agent?.command?.name).toBe("gitlab");
  });
});

describe("resolveOAuthProviderConfiguration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reports the env vars an operator still has to set", () => {
    const resolved = resolveOAuthProviderConfiguration(definition());
    expect(resolved).toEqual({
      configured: false,
      missing: ["VEKTOR_OAUTH_GITLAB_CLIENT_ID", "VEKTOR_OAUTH_GITLAB_CLIENT_SECRET"],
    });
  });

  it("names the variable after the provider id, hyphens included", () => {
    const resolved = resolveOAuthProviderConfiguration(
      definition({ ...gitlabIntegration, id: "my-tracker" }),
    );
    expect(resolved.configured).toBe(false);
    expect(resolved.configured === false && resolved.missing).toContain(
      "VEKTOR_OAUTH_MY_TRACKER_CLIENT_ID",
    );
  });

  it("fills {instance} from the default when the operator sets no base URL", () => {
    vi.stubEnv("VEKTOR_OAUTH_GITLAB_CLIENT_ID", "id");
    vi.stubEnv("VEKTOR_OAUTH_GITLAB_CLIENT_SECRET", "secret");

    const resolved = resolveOAuthProviderConfiguration(definition());
    expect(resolved.configured).toBe(true);
    if (!resolved.configured) return;
    expect(resolved.config.authorizationUrl).toBe("https://gitlab.com/oauth/authorize");
    expect(resolved.config.instanceUrl).toBe("https://gitlab.com");
    expect(resolved.config.scopes).toEqual(["api"]);
  });

  it("prefers the configured instance and scopes over the manifest's", () => {
    vi.stubEnv("VEKTOR_OAUTH_GITLAB_CLIENT_ID", "id");
    vi.stubEnv("VEKTOR_OAUTH_GITLAB_CLIENT_SECRET", "secret");
    vi.stubEnv("VEKTOR_OAUTH_GITLAB_BASE_URL", "https://gitlab.example.com/");
    vi.stubEnv("VEKTOR_OAUTH_GITLAB_SCOPES", "api,read_user");

    const resolved = resolveOAuthProviderConfiguration(definition());
    expect(resolved.configured).toBe(true);
    if (!resolved.configured) return;
    expect(resolved.config.tokenUrl).toBe("https://gitlab.example.com/oauth/token");
    expect(resolved.config.scopes).toEqual(["api", "read_user"]);
  });

  // A templated endpoint with nothing to fill it in would otherwise be fetched
  // with a literal "{instance}" in the URL.
  it("requires a base URL when the manifest names no default", () => {
    vi.stubEnv("VEKTOR_OAUTH_GITLAB_CLIENT_ID", "id");
    vi.stubEnv("VEKTOR_OAUTH_GITLAB_CLIENT_SECRET", "secret");
    vi.stubEnv("VEKTOR_OAUTH_GITLAB_BASE_URL", "");

    const resolved = resolveOAuthProviderConfiguration(
      definition({ ...gitlabIntegration, defaultInstanceUrl: undefined }),
    );
    expect(resolved).toEqual({
      configured: false,
      missing: ["VEKTOR_OAUTH_GITLAB_BASE_URL"],
    });
  });
});

describe("fetchOAuthExternalUser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const providerConfig = {
    id: "gitlab",
    label: "GitLab",
    clientId: "id",
    clientSecret: "secret",
    scopes: ["api"],
    authorizationUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    userInfoUrl: "https://gitlab.com/api/v4/user",
    instanceUrl: "https://gitlab.com",
    apiBasePath: "/api/v4",
    profile: { accountId: ["id", "ringId"], username: ["login", "name"] },
  };

  function stubProfile(profile: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(profile), { status: 200 })),
    );
  }

  it("maps the fields the manifest names, numbers included", async () => {
    stubProfile({ id: 42, name: "Ada" });
    await expect(fetchOAuthExternalUser(providerConfig, "token")).resolves.toEqual({
      accountId: "42",
      username: "Ada",
    });
  });

  it("falls through to the next field in order", async () => {
    stubProfile({ ringId: "ring-1", login: "ada" });
    await expect(fetchOAuthExternalUser(providerConfig, "token")).resolves.toEqual({
      accountId: "ring-1",
      username: "ada",
    });
  });

  it("fails when no field yields an account id", async () => {
    stubProfile({ name: "Ada" });
    await expect(fetchOAuthExternalUser(providerConfig, "token")).rejects.toThrow(
      /missing id \/ ringId/,
    );
  });
});
