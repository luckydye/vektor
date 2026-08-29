/**
 * Who may clone and who may push.
 *
 * A repository is a document, so its permissions are document permissions —
 * space roles, per-document grants and access tokens all reach it the same way
 * they reach anything else. That is the claim this spec is here to hold to,
 * driving a real `git` client over HTTP Basic auth.
 *
 * Run with:
 *   bunx --bun vitest run test/git-access.spec.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSessionApiRequest,
  createTestUser,
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

process.env.AUTH_SECRET ??= "git-access-test-secret-do-not-use-in-production";

const PORT = 7562;
const BASE_URL = testBaseUrl(PORT);
const HOST = `127.0.0.1:${PORT}`;
const apiRequest = createSessionApiRequest(BASE_URL);

let serverProcess: TestServerProcess;
let work: string;
let spaceId: string;
let spaceSlug: string;
let owner: Awaited<ReturnType<typeof createTestUser>>;
let editor: Awaited<ReturnType<typeof createTestUser>>;
let viewer: Awaited<ReturnType<typeof createTestUser>>;
let outsider: Awaited<ReturnType<typeof createTestUser>>;
let repoSlug: string;
let repoDocumentId: string;

/** A git command that reports its exit code rather than throwing. */
async function git(
  cwd: string,
  args: string[],
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["git", "-c", "credential.helper=", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  await new Response(proc.stdout).text();
  return { code, stderr };
}

/**
 * The clone URL with credentials in it, as git wants them.
 *
 * Always the owner's email: an access token authenticates as whoever minted it,
 * and it is the token's own grants — never that user's access — that decide
 * what it reaches. A viewer token held by the space owner must still not push.
 */
function cloneUrl(token: string, slug = repoSlug): string {
  return `http://${encodeURIComponent(owner.email)}:${token}@${HOST}/${spaceSlug}/git/${slug}.git`;
}

async function mintToken(
  permission: "viewer" | "editor",
  targetSpace = spaceId,
): Promise<string> {
  const response = await apiRequest(
    `/api/v1/spaces/${targetSpace}/access-tokens`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        name: `git-${permission}`,
        permission,
        resourceType: "space",
        resourceId: targetSpace,
      }),
    },
  );
  if (!response.ok) throw new Error(`Failed to mint token: ${response.status}`);
  return (await response.json()).token;
}

async function createRepositoryDocument(
  title: string,
): Promise<{ slug: string; id: string }> {
  const response = await apiRequest(`/api/v1/spaces/${spaceId}/documents`, owner.token, {
    method: "POST",
    body: JSON.stringify({ content: "", type: "repository", properties: { title } }),
  });
  if (!response.ok) throw new Error(`Failed to create repository: ${response.status}`);
  const created = await response.json();
  return { slug: created.document.slug, id: created.document.id };
}

async function grantSpaceRole(userId: string, role: string): Promise<void> {
  const response = await apiRequest(
    `/api/v1/spaces/${spaceId}/permissions`,
    owner.token,
    {
      method: "POST",
      body: JSON.stringify({
        type: "role",
        action: "grant",
        roleOrFeature: role,
        userId,
      }),
    },
  );
  if (!response.ok) throw new Error(`Failed to grant ${role}: ${response.status}`);
}

/** Seed the repository with one commit, pushed by an owner-scoped token. */
async function seed(token: string): Promise<void> {
  const dir = join(work, "seed");
  await git(work, ["init", "-q", "-b", "main", "seed"]);
  await git(dir, ["config", "user.email", owner.email]);
  await git(dir, ["config", "user.name", "Owner"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await Bun.write(join(dir, "README.md"), "# seeded\n");
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-qm", "seed"]);
  const push = await git(dir, ["push", cloneUrl(token), "main"]);
  expect(push.code).toBe(0);
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "vektor-git-access-"));
  serverProcess = startTestServer(PORT, {
    VEKTOR_IN_MEMORY_DB: "1",
    VEKTOR_EMAIL_AUTH: "1",
    AUTH_SECRET: process.env.AUTH_SECRET,
  });
  await waitForServer(BASE_URL);

  owner = await createTestUser(BASE_URL, "Repo Owner", "git-owner");
  editor = await createTestUser(BASE_URL, "Repo Editor", "git-editor");
  viewer = await createTestUser(BASE_URL, "Repo Viewer", "git-viewer");
  outsider = await createTestUser(BASE_URL, "Repo Outsider", "git-outsider");

  spaceSlug = `git-access-${Date.now()}`;
  const spaceResponse = await apiRequest("/api/v1/spaces", owner.token, {
    method: "POST",
    body: JSON.stringify({ name: "Git Access", slug: spaceSlug }),
  });
  if (!spaceResponse.ok) throw new Error(`Failed to create space`);
  spaceId = (await spaceResponse.json()).space.id;

  await grantSpaceRole(editor.userId, "editor");
  await grantSpaceRole(viewer.userId, "viewer");

  const repository = await createRepositoryDocument("Piano");
  repoSlug = repository.slug;
  repoDocumentId = repository.id;
  await seed(await mintToken("editor"));
}, 90_000);

afterAll(() => {
  serverProcess?.kill();
  rmSync(work, { recursive: true, force: true });
});

describe("a repository created as a document", () => {
  it("is reachable at its document slug", async () => {
    const token = await mintToken("viewer");
    const result = await git(work, ["clone", "-q", cloneUrl(token), "as-viewer"]);
    expect(result.code).toBe(0);
    expect(await Bun.file(join(work, "as-viewer", "README.md")).text()).toBe(
      "# seeded\n",
    );
  }, 30_000);

  it("is not reachable at a slug that is an ordinary document", async () => {
    // Only documents of type `repository` are repositories; a text document
    // must not become one by being asked for over git.
    const response = await apiRequest(
      `/api/v1/spaces/${spaceId}/documents`,
      owner.token,
      {
        method: "POST",
        body: JSON.stringify({ content: "", properties: { title: "Notes" } }),
      },
    );
    const notes = (await response.json()).document.slug;
    const token = await mintToken("viewer");
    const result = await git(work, ["clone", "-q", cloneUrl(token, notes), "not-a-repo"]);
    expect(result.code).not.toBe(0);
  }, 30_000);
});

describe("space roles reach the repository", () => {
  it("lets a viewer-scoped token clone", async () => {
    const token = await mintToken("viewer");
    const result = await git(work, ["clone", "-q", cloneUrl(token), "viewer-clone"]);
    expect(result.code).toBe(0);
  }, 30_000);

  it("refuses a push from a viewer-scoped token", async () => {
    // The whole point of separating upload-pack from receive-pack: read access
    // must not carry write access.
    const token = await mintToken("viewer");
    const dir = join(work, "viewer-clone");
    await git(dir, ["config", "user.email", viewer.email]);
    await git(dir, ["config", "user.name", "Viewer"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    await Bun.write(join(dir, "SNEAK.md"), "nope\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-qm", "sneak"]);

    const push = await git(dir, ["push", cloneUrl(token), "main"]);
    expect(push.code).not.toBe(0);
  }, 30_000);

  it("accepts a push from an editor-scoped token", async () => {
    const token = await mintToken("editor");
    const dir = join(work, "seed");
    await Bun.write(join(dir, "SECOND.md"), "second\n");
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-qm", "second"]);

    const push = await git(dir, ["push", cloneUrl(token), "main"]);
    expect(push.code).toBe(0);
  }, 30_000);
});

describe("browsing the repository document", () => {
  const browse = (token: string, query: string) =>
    apiRequest(
      `/api/v1/spaces/${spaceId}/documents/${repoDocumentId}/git?${query}`,
      token,
    );

  it("reports the branch and the commit at its head", async () => {
    const response = await browse(owner.token, "view=overview");
    expect(response.status).toBe(200);
    const summary = await response.json();
    expect(summary.empty).toBe(false);
    expect(summary.branch).toBe("main");
    expect(summary.head.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("lists the tree at the root", async () => {
    const response = await browse(owner.token, "view=tree&rev=main&path=");
    const { entries } = await response.json();
    expect(entries.map((entry: { name: string }) => entry.name)).toContain("README.md");
  });

  it("returns a file's text", async () => {
    const response = await browse(owner.token, "view=blob&rev=main&path=README.md");
    expect((await response.json()).text).toBe("# seeded\n");
  });

  it("shows the same repository to a space viewer", async () => {
    // The browser is the document, so a viewer reaches it exactly as they reach
    // any other document in the space.
    const response = await browse(viewer.token, "view=tree&rev=main&path=");
    expect(response.status).toBe(200);
  });

  it("refuses a caller with no access to the space", async () => {
    expect((await browse(outsider.token, "view=overview")).status).not.toBe(200);
  });

  it("refuses a rev that is not one", async () => {
    // Revs reach a command line, so anything option-shaped is turned away
    // before git ever sees it.
    expect((await browse(owner.token, "view=log&rev=--output%3D%2Ftmp%2Fx")).status).toBe(
      400,
    );
  });
});

describe("callers with no reach", () => {
  it("refuses an unauthenticated clone", async () => {
    const result = await git(work, [
      "clone",
      "-q",
      `http://${HOST}/${spaceSlug}/git/${repoSlug}.git`,
      "anon",
    ]);
    expect(result.code).not.toBe(0);
  }, 30_000);

  it("refuses a caller who holds nothing in the space", async () => {
    const result = await git(work, [
      "clone",
      "-q",
      `http://${encodeURIComponent(outsider.email)}:at_not_a_real_token@${HOST}/${spaceSlug}/git/${repoSlug}.git`,
      "outsider",
    ]);
    expect(result.code).not.toBe(0);
  }, 30_000);
});
