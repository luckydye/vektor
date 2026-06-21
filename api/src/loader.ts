import type { Loader } from "astro/loaders";
import type { VektorClient } from "./index.ts";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { join, extname } from "path";
import sharp from "sharp";

function contentExt(url: string, contentType: string): string {
  return (
    extname(new URL(url).pathname) ||
    (contentType.includes("png")
      ? ".png"
      : contentType.includes("gif")
        ? ".gif"
        : contentType.includes("webp")
          ? ".webp"
          : contentType.includes("svg")
            ? ".svg"
            : ".jpg")
  );
}

const RASTER = [".jpg", ".jpeg", ".png", ".webp", ".tiff"];

/** Caps the number of concurrent network fetches across the whole load. */
class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/** Parses a `srcset` value into its `{ url, descriptor }` candidates. */
function parseSrcset(value: string): { url: string; descriptor: string }[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, ...rest] = part.split(/\s+/);
      return { url, descriptor: rest.join(" ") };
    });
}

async function downloadImage(
  src: string,
  client: VektorClient,
  assetsDir: string,
  urlCache: Map<string, string>,
  gate: Semaphore,
): Promise<{ publicPath: string; filename: string } | null> {
  let absoluteUrl: string;
  try {
    absoluteUrl = new URL(src, client.baseUrl).toString();
  } catch {
    return null;
  }

  if (urlCache.has(absoluteUrl)) {
    const filename = urlCache.get(absoluteUrl)!;
    if (existsSync(join(assetsDir, filename))) {
      return { publicPath: `/vektor-assets/${filename}`, filename };
    }
    urlCache.delete(absoluteUrl);
  }

  try {
    const response = await gate.run(() => client.fetchUrl(absoluteUrl));
    if (!response.ok) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    const contentHash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
    const ext = contentExt(absoluteUrl, response.headers.get("content-type") ?? "");

    let buf: Buffer;
    let finalExt: string;
    if (RASTER.includes(ext.toLowerCase())) {
      buf = await sharp(bytes).webp({ quality: 82 }).toBuffer();
      finalExt = ".webp";
    } else {
      buf = bytes;
      finalExt = ext;
    }

    const filename = `${contentHash}${finalExt}`;
    writeFileSync(join(assetsDir, filename), buf);
    urlCache.set(absoluteUrl, filename);
    return { publicPath: `/vektor-assets/${filename}`, filename };
  } catch {
    return null;
  }
}

const IMG_TAG = /<img\b[^>]*>/gi;
const IMG_ATTR = /\b(src|srcset)\s*=\s*(["'])([^"']*)\2/gi;

async function rewriteImages(
  html: string,
  client: VektorClient,
  assetsDir: string,
  urlCache: Map<string, string>,
  gate: Semaphore,
): Promise<string> {
  // Collect candidate URLs from src/srcset on <img> tags only.
  const srcs = new Set<string>();
  for (const [tag] of html.matchAll(IMG_TAG)) {
    for (const [, name, , value] of tag.matchAll(IMG_ATTR)) {
      const urls = name.toLowerCase() === "src" ? [value] : parseSrcset(value).map((c) => c.url);
      for (const url of urls) {
        if (url && !url.startsWith("data:")) srcs.add(url);
      }
    }
  }

  const rewrites = new Map<string, string>();
  await Promise.all(
    [...srcs].map(async (src) => {
      const result = await downloadImage(src, client, assetsDir, urlCache, gate);
      if (result) rewrites.set(src, result.publicPath);
    }),
  );

  // Rewrite only within <img> tags, leaving other elements' src untouched.
  return html.replace(IMG_TAG, (tag) =>
    tag.replace(IMG_ATTR, (match, name: string, quote: string, value: string) => {
      if (name.toLowerCase() === "src") {
        const local = rewrites.get(value);
        return local ? `${name}=${quote}${local}${quote}` : match;
      }
      const rewritten = parseSrcset(value)
        .map(({ url, descriptor }) => {
          const finalUrl = rewrites.get(url) ?? url;
          return descriptor ? `${finalUrl} ${descriptor}` : finalUrl;
        })
        .join(", ");
      return `${name}=${quote}${rewritten}${quote}`;
    }),
  );
}

export function vektorLoader(client: VektorClient, spaceId?: string): Loader {
  return {
    name: "vektor-loader",
    async load({ store, meta, logger, generateDigest, config }) {
      const assetsDir = join(fileURLToPath(config.publicDir), "vektor-assets");
      mkdirSync(assetsDir, { recursive: true });

      // Funnels every network fetch (documents + images) through one cap so a
      // large space can't open hundreds of simultaneous connections.
      const gate = new Semaphore(12);
      const urlCache = new Map<string, string>(JSON.parse(meta.get("urlCache") ?? "[]"));

      // Bust cached entries for rasters that should now be WebP
      for (const [url, filename] of urlCache) {
        if (RASTER.filter((e) => e !== ".webp").includes(extname(filename).toLowerCase()))
          urlCache.delete(url);
      }

      if (!spaceId) {
        const spaces = await client.listSpaces();
        if (spaces.length === 0) throw new Error("No spaces found for this token.");
        spaceId = spaces[0].id;
        logger.info(`Using space: ${spaces[0].name} (${spaceId})`);
      }

      const PAGE_SIZE = 500;
      const documents: Awaited<ReturnType<typeof client.listDocuments>>["documents"] = [];
      let cursor: string | undefined;
      for (;;) {
        const page = await client.listDocuments(spaceId, {
          limit: PAGE_SIZE,
          cursor,
        });
        documents.push(...page.documents);
        if (!page.nextCursor || page.documents.length === 0) break;
        cursor = page.nextCursor;
      }
      const published = documents.filter((doc) => doc.publishedRev !== null);
      logger.info(`Fetching ${published.length} published document(s) from Vektor (${documents.length - published.length} unpublished skipped)...`);

      const seen = new Set<string>();

      await Promise.all(
        published.map(async (doc) => {
          let full;
          let revision;
          try {
            [full, revision] = await Promise.all([
              gate.run(() => client.getDocument(spaceId, doc.id)),
              gate.run(() => client.getRevision(spaceId, doc.id, doc.publishedRev!)),
            ]);
          } catch {
            logger.warn(`Skipping document ${doc.id} (${doc.slug}): not found`);
            return;
          }
          const slug = full.properties.slug ?? doc.slug;
          seen.add(slug);

          const rawHeaderImage = full.properties.headerImage ?? null;
          const [content, headerImageResult] = await Promise.all([
            revision.content ? rewriteImages(revision.content, client, assetsDir, urlCache, gate) : null,
            rawHeaderImage ? downloadImage(rawHeaderImage, client, assetsDir, urlCache, gate) : null,
          ]);

          store.set({
            id: slug,
            digest: generateDigest({ v: 9, id: doc.id, updatedAt: full.updatedAt }),
            data: {
              docId: full.id,
              parentId: full.parentId,
              title: full.properties.title ?? null,
              headerImage: headerImageResult?.filename ?? null,
              content,
              updatedAt: full.updatedAt,
              properties: full.properties,
            },
          });
        }),
      );

      for (const key of store.keys()) {
        if (!seen.has(key)) store.delete(key);
      }

      // Build referencedFiles after all downloads complete
      const referencedFiles = new Set(urlCache.values());

      for (const file of readdirSync(assetsDir)) {
        if (!referencedFiles.has(file)) rmSync(join(assetsDir, file));
      }

      for (const [url, filename] of urlCache) {
        if (!referencedFiles.has(filename)) urlCache.delete(url);
      }

      meta.set("urlCache", JSON.stringify([...urlCache]));
      logger.info(`Loaded ${published.length} document(s).`);
    },
  };
}
