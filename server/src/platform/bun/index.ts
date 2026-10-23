import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gitRoutes } from "#api/gitRoutes.ts";
import { config } from "#config";
import { createPlatformState } from "#db/client/db.ts";
import type { BlobStore } from "#files/storage.ts";
import { invalidateCache } from "#git/cache.ts";
import type { LocalJobFile, Platform } from "#platform/platform.ts";
import { assertOutsideTransaction } from "#utils/transactionScope.ts";
import { createDatabase, dataDirectory, getAuthDatabaseUrl } from "./database.ts";
import { createBunFetch } from "./fetch.ts";
import { diskJobCacheStore } from "./jobCacheStore.ts";
import { createBoaJobVm } from "./jobVm.ts";
import { createLocalBlobStore } from "./localBlobStore.ts";
import { smtpMailer } from "./mailer.ts";
import { getNativeEmbedding, getNativeImage } from "./native.ts";
import { createS3BlobStore } from "./s3BlobStore.ts";
import { poolDocSerializer } from "./serializationPool.ts";
import { createLibsqlSpaceDatabase } from "./spaceDatabase.ts";
import { createTimerSpaceHost } from "./spaceHost.ts";

/** S3-compatible object storage when a bucket is set, and `data/uploads` otherwise. */
function configuredBlobStore(): BlobStore {
  const env = config();
  const bucket = env.S3_BUCKET?.trim();
  if (!bucket) return createLocalBlobStore(join(dataDirectory(), "uploads"));

  return createS3BlobStore({
    bucket,
    endpoint: env.S3_ENDPOINT?.trim() || undefined,
    region: env.S3_REGION?.trim() || undefined,
    accessKeyId: env.S3_ACCESS_KEY_ID?.trim() || undefined,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY?.trim() || undefined,
    sessionToken: env.S3_SESSION_TOKEN?.trim() || undefined,
    virtualHostedStyle:
      env.S3_VIRTUAL_HOSTED_STYLE === "1" || env.S3_VIRTUAL_HOSTED_STYLE === "true",
    prefix: env.S3_PREFIX?.trim() || undefined,
    stagingDir: join(dataDirectory(), "s3-staging"),
  });
}

/** `.mjs` bundles in `./jobs`, read relative to the working directory. */
function localJobFiles(): LocalJobFile[] {
  const directory = join(process.cwd(), "jobs");
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".mjs"));
  } catch {
    return [];
  }
  return names.map((name) => ({ name, data: readFileSync(join(directory, name)) }));
}

/** The self-hosted binary: one process for every space, everything on local disk. */
export function createBunPlatform(): Platform {
  // Resolved on first use rather than here, so the environment is read after config.
  let blobStore: BlobStore | undefined;
  let transformCache: BlobStore | undefined;

  const platform: Platform = {
    // Through `createDatabase`, so an in-memory auth database is tracked like a space one.
    globalDatabase: { open: () => createDatabase(getAuthDatabaseUrl()) },
    spaceDatabase: createLibsqlSpaceDatabase(() => platform),
    get blobStore() {
      blobStore ??= configuredBlobStore();
      return blobStore;
    },
    // Local whatever the blob store is, and under the working directory rather than `DATA_DIR`.
    get transformCache() {
      transformCache ??= createLocalBlobStore(
        resolve(process.cwd(), "data", "transforms"),
      );
      return transformCache;
    },
    jobCache: diskJobCacheStore,

    imageTransformer: {
      async transform(input, options) {
        assertOutsideTransaction("platform.imageTransformer.transform");
        const native = await getNativeImage();
        return native && Buffer.from(native.transform(input, options));
      },
      async metadata(input) {
        assertOutsideTransaction("platform.imageTransformer.metadata");
        const native = await getNativeImage();
        if (!native) throw new Error("image.metadata: the image addon is unavailable");
        return native.metadata(input);
      },
    },

    embedder: {
      model: "Qdrant/bge-small-en-v1.5-onnx-Q@c32e6154d1bb7a0e47c5e745fd895e7700f44385",
      async embed(texts) {
        assertOutsideTransaction("platform.embedder.embed");
        return texts.length === 0 ? [] : (await getNativeEmbedding()).embed(texts);
      },
    },

    jobVm: createBoaJobVm({
      // The document-conversion tools the image installs; one that does not ship
      // would be admitted the day it does.
      execAllowlist: new Set(["htmlq", "pandoc", "rsvg-convert"]),
    }),

    docSerializer: poolDocSerializer,

    passwordHasher: {
      hash: (password) => Bun.password.hash(password),
      verify: (password, hash) => Bun.password.verify(password, hash),
    },

    mailer: smtpMailer,

    spaceHost: createTimerSpaceHost(() => platform),

    fetch: createBunFetch(),

    git: { routes: gitRoutes, forget: invalidateCache },

    localJobFiles,
    state: createPlatformState(),
  };
  return platform;
}
