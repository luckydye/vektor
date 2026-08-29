/**
 * Repositories end to end: a real `git` client against the real pipeline —
 * `git-http-backend`, the cache, and publication into object storage.
 *
 * The test that matters is the cold clone. Push, delete the entire cache
 * directory, clone again: if the bytes come back, object storage genuinely is
 * the source of truth rather than a copy of local disk.
 *
 * Run with:
 *   bunx --bun vitest run test/git-repositories.spec.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isGitPath } from "#api/server/router.ts";
import { createLocalFileStorage, type FileStorageAdapter } from "#files/storage.ts";
import { cachePath, ensureCache, withRepoLock } from "#git/cache.ts";
import { runHttpBackend } from "#git/httpBackend.ts";
import { publishPush, readRefs, sweepOrphanedPacks } from "#git/publish.ts";
import { createRepo, deleteRepo, getRepo, listRepos } from "#git/repos.ts";
import { applyEntry, conflictsWith, type RepoState, readState } from "#git/state.ts";
import {
  startTestServer,
  type TestServerProcess,
  testBaseUrl,
  waitForServer,
} from "./helpers/server.ts";

const SPACE = "space_git";
const SLUG = "piano";

let root: string;
let work: string;
let storage: FileStorageAdapter;
let server: ReturnType<typeof Bun.serve>;
let origin: string;

/**
 * The route's own logic, minus space resolution and access control: enough to
 * drive a real git client at the parts this phase builds.
 */
async function serveRepo(slug: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  // Same shape the route serves: /<space>/git/<repo>.git/<backend path>
  const path = url.pathname.split("/").slice(4).join("/");
  const query = url.search.slice(1);
  const write = path === "git-receive-pack" || query.includes("service=git-receive-pack");

  const run = async () => {
    const cache = await ensureCache(storage, SPACE, slug);
    if (!cache) return new Response("Not found", { status: 404 });

    const before = write ? await readRefs(cache.dir) : {};
    const response = await runHttpBackend({
      dir: cache.dir,
      path,
      method: request.method,
      query,
      headers: request.headers,
      body: request.body,
      remoteUser: "tester@example.com",
    });

    if (path !== "git-receive-pack") {
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    }

    const reported = await new Response(response.body).arrayBuffer();
    const result = await publishPush(
      storage,
      SPACE,
      SLUG,
      cache.dir,
      cache.loaded,
      before,
    );
    if (!result.published) return new Response("Conflict", { status: 409 });
    return new Response(reported, {
      status: response.status,
      headers: response.headers,
    });
  };

  return write ? withRepoLock(SPACE, slug, run) : run();
}

/** A git command in `cwd`, failing the test with stderr rather than silently. */
async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${stderr}`);
  return stdout;
}

async function commit(dir: string, file: string, body: string): Promise<void> {
  await Bun.write(join(dir, file), body);
  await git(dir, ["add", "."]);
  await git(dir, ["commit", "-q", "-m", `add ${file}`]);
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "vektor-git-storage-"));
  work = mkdtempSync(join(tmpdir(), "vektor-git-work-"));
  storage = createLocalFileStorage(root);

  await createRepo(storage, SPACE, { slug: SLUG, createdBy: "tester" });

  server = Bun.serve({ port: 0, fetch: (request) => serveRepo(SLUG, request) });
  origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe("creating a repository", () => {
  it("claims the slug exactly once", async () => {
    expect(
      await createRepo(storage, SPACE, { slug: SLUG, createdBy: "someone" }),
    ).toBeNull();
  });

  it("is listed and readable by slug", async () => {
    expect((await getRepo(storage, SPACE, SLUG))?.slug).toBe(SLUG);
    expect((await listRepos(storage, SPACE)).map((repo) => repo.slug)).toContain(SLUG);
  });

  it("refuses a slug that would escape its prefix", async () => {
    expect(await getRepo(storage, SPACE, "../other")).toBeNull();
  });
});

describe("an empty repository", () => {
  it("clones, with HEAD pointing at the branch it was created for", async () => {
    // A fresh bare repo's HEAD follows git's own default unless told
    // otherwise, so an empty clone is where a wrong default first shows up.
    await createRepo(storage, SPACE, { slug: "hollow", createdBy: "tester" });
    const empty = Bun.serve({
      port: 0,
      fetch: (request) => serveRepo("hollow", request),
    });
    try {
      await git(work, [
        "clone",
        "-q",
        `http://127.0.0.1:${empty.port}/${SPACE}/git/hollow.git`,
        "hollow",
      ]);
      const head = await git(join(work, "hollow"), ["symbolic-ref", "HEAD"]);
      expect(head.trim()).toBe("refs/heads/main");
    } finally {
      empty.stop(true);
    }
  }, 30_000);
});

describe("push and clone", () => {
  it("accepts a push over smart HTTP", async () => {
    const dir = join(work, "author");
    await git(work, ["init", "-q", "-b", "main", "author"]);
    await git(dir, ["config", "user.email", "tester@example.com"]);
    await git(dir, ["config", "user.name", "Tester"]);
    await git(dir, ["config", "commit.gpgsign", "false"]);
    await commit(dir, "README.md", "# piano\n");
    await git(dir, ["remote", "add", "origin", `${origin}/${SPACE}/git/${SLUG}.git`]);
    await git(dir, ["push", "-q", "origin", "main"]);

    const state = (await readState(storage, SPACE, SLUG))?.state;
    expect(state?.refs["refs/heads/main"]).toMatch(/^[0-9a-f]{40}$/);
    expect(state?.packs).toHaveLength(1);
    expect(state?.log.at(-1)?.refUpdates).toEqual([
      { name: "refs/heads/main", from: null, to: state?.refs["refs/heads/main"] },
    ]);
  });

  it("serves a clone of what was pushed", async () => {
    await git(work, ["clone", "-q", `${origin}/${SPACE}/git/${SLUG}.git`, "reader"]);
    expect(await Bun.file(join(work, "reader", "README.md")).text()).toBe("# piano\n");
  });

  it("clones from object storage alone, with the cache deleted", async () => {
    // The acceptance test for the whole phase: nothing but the bucket is left.
    await rm(cachePath(SPACE, SLUG), { recursive: true, force: true });

    await git(work, ["clone", "-q", `${origin}/${SPACE}/git/${SLUG}.git`, "cold"]);
    expect(await Bun.file(join(work, "cold", "README.md")).text()).toBe("# piano\n");

    const authored = await git(join(work, "author"), ["rev-parse", "HEAD"]);
    const cloned = await git(join(work, "cold"), ["rev-parse", "HEAD"]);
    expect(cloned).toBe(authored);
  });

  it("carries a second push through to a cold clone", async () => {
    const dir = join(work, "author");
    await commit(dir, "SONG.md", "chorus\n");
    await git(dir, ["push", "-q", "origin", "main"]);

    await rm(cachePath(SPACE, SLUG), { recursive: true, force: true });
    await git(work, ["clone", "-q", `${origin}/${SPACE}/git/${SLUG}.git`, "cold2"]);
    expect(await Bun.file(join(work, "cold2", "SONG.md")).text()).toBe("chorus\n");
  });

  it("keeps every pushed pack in storage", async () => {
    const state = (await readState(storage, SPACE, SLUG))?.state;
    const { files } = await storage.list(SPACE, { prefix: `git/${SLUG}/pack/` });
    for (const name of state?.packs ?? []) {
      expect(files.some((file) => file.key.endsWith(`${name}.pack`))).toBe(true);
      expect(files.some((file) => file.key.endsWith(`${name}.idx`))).toBe(true);
    }
  });

  it("writes no loose objects, only packs", async () => {
    // `receive.unpackLimit=0` is what makes the storage model work: loose
    // objects would be thousands of small keys instead of one immutable blob.
    const objects = join(cachePath(SPACE, SLUG), "objects");
    const entries = await readdir(objects);
    expect(entries.filter((entry) => /^[0-9a-f]{2}$/.test(entry))).toEqual([]);
  });
});

describe("a lost compare-and-swap", () => {
  const base = (refs: Record<string, string>): RepoState => ({
    version: 1,
    slug: SLUG,
    defaultBranch: "main",
    createdAt: "",
    createdBy: "",
    refs,
    packs: [],
    seq: 0,
    log: [],
  });

  it("does not conflict when the winner touched another branch", () => {
    // The property the whole retry exists for. Two people pushing different
    // branches both write one state object, and the loser is still valid.
    const winner = applyEntry(
      base({ "refs/heads/main": "aaa" }),
      [],
      [{ name: "refs/heads/feature", from: null, to: "ccc" }],
    );
    expect(
      conflictsWith(winner, [{ name: "refs/heads/main", from: "aaa", to: "bbb" }]),
    ).toBe(false);
  });

  it("conflicts when the winner moved the same ref", () => {
    const winner = applyEntry(
      base({ "refs/heads/main": "aaa" }),
      [],
      [{ name: "refs/heads/main", from: "aaa", to: "ccc" }],
    );
    expect(
      conflictsWith(winner, [{ name: "refs/heads/main", from: "aaa", to: "bbb" }]),
    ).toBe(true);
  });

  it("conflicts when someone else created the branch first", () => {
    const winner = applyEntry(
      base({}),
      [],
      [{ name: "refs/heads/new", from: null, to: "ccc" }],
    );
    expect(
      conflictsWith(winner, [{ name: "refs/heads/new", from: null, to: "bbb" }]),
    ).toBe(true);
  });

  it("rejects a second push built on a ref that has moved", async () => {
    const dir = join(work, "author");
    await git(work, ["clone", "-q", `${origin}/${SPACE}/git/${SLUG}.git`, "stale"]);
    const stale = join(work, "stale");
    await git(stale, ["config", "user.email", "other@example.com"]);
    await git(stale, ["config", "user.name", "Other"]);
    await git(stale, ["config", "commit.gpgsign", "false"]);

    // Both sides commit on top of the same base; the first to arrive wins.
    await commit(dir, "FIRST.md", "first\n");
    await git(dir, ["push", "-q", "origin", "main"]);
    await commit(stale, "SECOND.md", "second\n");

    await expect(git(stale, ["push", "origin", "main"])).rejects.toThrow();
    expect(await Bun.file(join(work, "author", "FIRST.md")).text()).toBe("first\n");
  });
});

describe("repack", () => {
  it("consolidates once the pack count passes the threshold", async () => {
    const dir = join(work, "author");
    for (let i = 0; i < 14; i++) {
      await commit(dir, `track-${i}.md`, `track ${i}\n`);
      await git(dir, ["push", "-q", "origin", "main"]);
    }

    // Cold-start cost is proportional to pack count, so it must not simply
    // grow with every push.
    const state = (await readState(storage, SPACE, SLUG))?.state;
    expect(state?.packs.length).toBeLessThanOrEqual(12);

    await rm(cachePath(SPACE, SLUG), { recursive: true, force: true });
    await git(work, ["clone", "-q", `${origin}/${SPACE}/git/${SLUG}.git`, "packed"]);
    expect(await Bun.file(join(work, "packed", "track-13.md")).text()).toBe("track 13\n");
    // Fourteen real pushes through a real git client; the default 5s is for
    // tests that do not spawn a process per assertion.
  }, 60_000);
});

describe("the routing gate", () => {
  // Duplicated in the server and the API router and run on every request, so
  // its edges are pinned here rather than left to the two call sites.
  it.each([
    ["/personal/git/piano.git/info/refs", true],
    ["/personal/git/piano/git-upload-pack", true],
    ["/personal/git/", true],
    ["/personal/git", false],
    ["/personal/gitlab/x", false],
    ["/personal/doc/git/notes", false],
    ["/git/personal/piano.git", false],
    ["//git/x", false],
    ["/", false],
    ["", false],
  ])("%s -> %s", (pathname, expected) => {
    expect(isGitPath(pathname)).toBe(expected);
  });
});

describe("the clone URL", () => {
  // The route lives at the repository's own address rather than under /api, so
  // `isGitPath` — duplicated in the server and the API router — is what decides
  // whether it is reached at all. Miss one copy and the request either 404s as
  // an unknown API path or falls through to the frontend.
  const PORT = 7541;
  const appUrl = testBaseUrl(PORT);
  let serverProcess: TestServerProcess;

  beforeAll(async () => {
    serverProcess = startTestServer(PORT, { VEKTOR_NO_AUTH: "1" });
    await waitForServer(appUrl);
  }, 60_000);

  afterAll(() => {
    serverProcess?.kill();
  });

  it("is served by the git route, not the frontend", async () => {
    const response = await fetch(
      `${appUrl}/no-such-space/git/piano.git/info/refs?service=git-upload-pack`,
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Not found\n");
  });

  it("leaves ordinary space paths alone", async () => {
    const response = await fetch(`${appUrl}/no-such-space/somewhere`);
    expect(await response.text()).not.toBe("Not found\n");
  });

  it("accepts a clone URL without the conventional .git suffix", async () => {
    const response = await fetch(
      `${appUrl}/no-such-space/git/piano/info/refs?service=git-upload-pack`,
    );
    expect(await response.text()).toBe("Not found\n");
  });
});

describe("housekeeping", () => {
  it("leaves live packs alone when sweeping orphans", async () => {
    expect(await sweepOrphanedPacks(storage, SPACE, SLUG)).toBe(0);
  });

  it("deletes a repository's objects, not just its cache", async () => {
    await createRepo(storage, SPACE, { slug: "doomed", createdBy: "tester" });
    expect(await deleteRepo(storage, SPACE, "doomed")).toBe(true);

    const { files } = await storage.list(SPACE, { prefix: "git/doomed/" });
    expect(files).toEqual([]);
    expect(await getRepo(storage, SPACE, "doomed")).toBeNull();
  });
});
