import { afterEach, describe, expect, it } from "bun:test";
import {
  ApiClient,
  type Category,
  type DocumentWithProperties,
  type Space,
} from "#api/ApiClient.ts";
import { ApiReplica } from "#api/ApiReplica.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("ApiReplica", () => {
  it("stores cacheable API reads in the configured identity scope", async () => {
    const client = new ApiClient({ baseUrl: "https://api.example.test" });
    client.setReplicaScope("user:one");
    const spaces: Space[] = [
      {
        id: "space_1",
        name: "One",
        slug: "one",
        createdBy: "user_1",
        preferences: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    globalThis.fetch = (async () => Response.json(spaces)) as typeof fetch;

    await client.spaces.get();

    expect(await client.readReplica<Space[]>("/api/v1/spaces")).toEqual(spaces);
  });

  it("does not persist transient or identity-supporting reads", async () => {
    const client = new ApiClient({ baseUrl: "https://api.example.test" });
    client.setReplicaScope("user:one");
    globalThis.fetch = (async () => Response.json({ ok: true })) as typeof fetch;

    const paths = [
      "/api/v1/users?spaceId=space_1",
      "/api/v1/spaces/space_1/members",
      "/api/v1/spaces/space_1/permissions/me",
      "/api/v1/spaces/space_1/documents/document_1/breadcrumbs",
      "/api/v1/spaces/space_1/documents/document_1/audit-logs",
      "/api/v1/spaces/space_1/documents/document_1/contributors",
    ];

    for (const path of paths) {
      await client.apiGet(client.baseUrl, path);
      expect(await client.readReplica(path)).toBeUndefined();
    }
  });

  it("replaces an ApiClient optimistic mutation with its canonical response", async () => {
    const client = new ApiClient({ baseUrl: "https://api.example.test" });
    client.setReplicaScope("user:one");
    const path = "/api/v1/spaces/space_1/categories";
    const existing: Category = {
      id: "category_1",
      name: "Before",
      slug: "before",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const remote: Category = { ...existing, name: "From server", slug: "from-server" };
    let allowResponse!: () => void;
    let signalRequestStarted!: () => void;
    const responseAllowed = new Promise<void>((resolve) => {
      allowResponse = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      signalRequestStarted = resolve;
    });

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "PUT") {
        signalRequestStarted();
        await responseAllowed;
        return Response.json({ category: remote });
      }
      return Response.json({ categories: [existing] });
    }) as typeof fetch;

    await client.categories.get("space_1");
    const updating = client.category.put("space_1", existing.id, { name: "Local" });
    await requestStarted;

    expect(
      (await client.readReplica<{ categories: Category[] }>(path))?.categories[0].name,
    ).toBe("Local");

    allowResponse();
    await updating;

    expect(
      (await client.readReplica<{ categories: Category[] }>(path))?.categories[0],
    ).toEqual(remote);
  });

  it("replaces the optimistic published revision with the server revision", async () => {
    const client = new ApiClient({ baseUrl: "https://api.example.test" });
    client.setReplicaScope("user:one");
    const document: DocumentWithProperties = {
      id: "document_1",
      slug: "document-one",
      type: "document",
      content: "<p>Before</p>",
      currentRev: 2,
      publishedRev: null,
      parentId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      createdBy: "user_1",
      updatedBy: "user_1",
      properties: {},
    };
    const published = {
      ...document,
      content: "<p>Published</p>",
      currentRev: 3,
      publishedRev: 3,
    };
    let allowResponse!: () => void;
    let signalRequestStarted!: () => void;
    const responseAllowed = new Promise<void>((resolve) => {
      allowResponse = resolve;
    });
    const requestStarted = new Promise<void>((resolve) => {
      signalRequestStarted = resolve;
    });

    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "PUT") {
        signalRequestStarted();
        await responseAllowed;
        return Response.json({ document: published });
      }
      return Response.json({ document });
    }) as typeof fetch;

    await client.document.get("space_1", document.id);
    expect(
      await client.readReplica<{ document: DocumentWithProperties }>(
        `/api/v1/spaces/space_1/documents/${document.id}`,
      ),
    ).toBeUndefined();

    const publishing = client.document.put("space_1", document.id, "<p>Published</p>", {
      publish: true,
    });
    await requestStarted;

    expect((await client.readDocumentReplica("space_1", document.id))?.publishedRev).toBe(
      0,
    );
    expect(
      (await client.readDocumentReplica("space_1", document.slug))?.publishedRev,
    ).toBe(0);

    allowResponse();
    await publishing;

    expect(
      (await client.readDocumentReplica("space_1", document.slug))?.publishedRev,
    ).toBe(3);
  });

  it("lets a remote response replace an optimistic value permanently", async () => {
    const replica = new ApiReplica();
    const key = "document:doc_1";

    await replica.replaceRemote(key, { title: "Original" });
    const operation = await replica.applyOptimistic<{ title: string }>(
      key,
      (current) => ({
        title: `${current?.title} locally`,
      }),
    );

    expect((await replica.get<{ title: string }>(key))?.value).toEqual({
      title: "Original locally",
    });

    await replica.replaceRemote(key, { title: "Remote" });
    await replica.rollback(operation);

    const entry = await replica.get<{ title: string }>(key);
    expect(entry?.value).toEqual({ title: "Remote" });
    expect(entry?.source).toBe("remote");
  });

  it("rolls back a failed optimistic update when it still owns the entry", async () => {
    const replica = new ApiReplica();
    const key = "category:cat_1";

    await replica.replaceRemote(key, { name: "Before" });
    const operation = await replica.applyOptimistic<{ name: string }>(key, () => ({
      name: "Pending",
    }));
    await replica.rollback(operation);

    const entry = await replica.get<{ name: string }>(key);
    expect(entry?.value).toEqual({ name: "Before" });
    expect(entry?.source).toBe("remote");
  });

  it("notifies observers for optimistic and remote values", async () => {
    const replica = new ApiReplica();
    const received: Array<string | undefined> = [];
    const unsubscribe = replica.subscribe<{ value: string }>("space:one", (entry) => {
      received.push(entry?.value.value);
    });

    await replica.applyOptimistic("space:one", () => ({ value: "local" }));
    await replica.replaceRemote("space:one", { value: "server" });
    unsubscribe();

    expect(received).toEqual(["local", "server"]);
  });
});
