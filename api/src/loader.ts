import type { Loader } from "astro/loaders";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { extname, join } from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";
import type { Document, VektorClient } from "./index.ts";

export type VektorLoaderRevision = "published" | "current";
export type VektorLoaderAssetMode = "download" | "remote";

export interface VektorLoaderOptions {
  /** Space to load. Defaults to the first space visible to the token. */
  spaceId?: string;
  /**
   * Which document content to load.
   *
   * - "published" preserves the original loader behavior and skips unpublished documents.
   * - "current" reads the current document body, including unpublished drafts.
   */
  revision?: VektorLoaderRevision;
  /**
   * How remote image URLs inside Vektor HTML should be handled.
   *
   * - "download" preserves the original loader behavior by caching <img> assets in public/vektor-assets.
   * - "remote" leaves URLs untouched so the built site serves assets from Vektor.
   */
  assetMode?: VektorLoaderAssetMode;
  /** Restrict the initial document listing to these Vektor category slugs. */
  categorySlugs?: string[];
  /**
   * Names of properties whose value is a JSON-encoded array of URLs (e.g. a
   * gallery) or a JSON-encoded object mapping keys to URLs (e.g. a site-asset
   * manifest with favicon/logo/video entries). In "download" asset mode,
   * absolute URLs are downloaded like `headerImage` and the property is
   * rewritten in place with local paths, preserving its array/object shape;
   * relative/local values are left untouched.
   */
  assetProperties?: string[];
  /**
   * Keep only documents whose properties match these values. Use `null` to mean
   * "property must be present with any value".
   */
  propertyFilters?: Record<string, string | null>;
  /** Last-mile filter for custom document selection. */
  filter?: (document: Document) => boolean;
}

interface NormalizedVektorLoaderOptions {
  spaceId?: string;
  revision: VektorLoaderRevision;
  assetMode: VektorLoaderAssetMode;
  categorySlugs?: string[];
  propertyFilters: Record<string, string | null>;
  assetProperties: string[];
  filter?: (document: Document) => boolean;
}

function normalizeOptions(
  spaceIdOrOptions?: string | VektorLoaderOptions,
): NormalizedVektorLoaderOptions {
  const options =
    typeof spaceIdOrOptions === "string" ? { spaceId: spaceIdOrOptions } : (spaceIdOrOptions ?? {});
  return {
    spaceId: options.spaceId,
    revision: options.revision ?? "published",
    assetMode: options.assetMode ?? "download",
    categorySlugs: options.categorySlugs,
    propertyFilters: options.propertyFilters ?? {},
    assetProperties: options.assetProperties ?? [],
    filter: options.filter,
  };
}

function isAbsoluteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** Parses a property value as either a JSON array or object of URLs. Returns null if neither. */
function parseAssetContainer(value: string | undefined): string[] | Record<string, string> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === "string");
    if (parsed && typeof parsed === "object") {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>;
    }
    return null;
  } catch {
    return null;
  }
}

function matchesPropertyFilters(
  document: Pick<Document, "properties">,
  filters: Record<string, string | null>,
): boolean {
  return Object.entries(filters).every(([key, value]) => {
    if (!(key in document.properties)) return false;
    return value === null || document.properties[key] === value;
  });
}

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
      const urls =
        name.toLowerCase() === "src" ? [value] : parseSrcset(value).map((c) => c.url);
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

export function vektorLoader(
  client: VektorClient,
  spaceIdOrOptions?: string | VektorLoaderOptions,
): Loader {
  const options = normalizeOptions(spaceIdOrOptions);
  return {
    name: "vektor-loader",
    async load({ store, meta, logger, generateDigest, config }) {
      const assetsDir = join(fileURLToPath(config.publicDir), "vektor-assets");
      if (options.assetMode === "download") mkdirSync(assetsDir, { recursive: true });

      // Funnels every network fetch (documents + images) through one cap so a
      // large space can't open hundreds of simultaneous connections.
      const gate = new Semaphore(12);
      const urlCache = new Map<string, string>(JSON.parse(meta.get("urlCache") ?? "[]"));

      // Bust cached entries for rasters that should now be WebP
      for (const [url, filename] of urlCache) {
        if (RASTER.filter((e) => e !== ".webp").includes(extname(filename).toLowerCase()))
          urlCache.delete(url);
      }

      let spaceId = options.spaceId;
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
          categorySlugs: options.categorySlugs,
        });
        documents.push(...page.documents);
        if (!page.nextCursor || page.documents.length === 0) break;
        cursor = page.nextCursor;
      }
      const selected = documents
        .filter((doc) =>
          options.revision === "published" ? doc.publishedRev !== null : true,
        )
        .filter((doc) => matchesPropertyFilters(doc, options.propertyFilters))
        .filter((doc) => (options.filter ? options.filter(doc) : true));
      const skipped = documents.length - selected.length;
      logger.info(
        `Fetching ${selected.length} ${options.revision} document(s) from Vektor (${skipped} skipped)...`,
      );

      const seen = new Set<string>();

      await Promise.all(
        selected.map(async (doc) => {
          let full;
          let content: string | null = null;
          try {
            full = await gate.run(() => client.getDocument(spaceId, doc.id));
            if (options.revision === "published") {
              const revision = await gate.run(() =>
                client.getRevision(spaceId, doc.id, doc.publishedRev!),
              );
              content = revision.content;
            } else {
              content = full.content ?? null;
            }
          } catch {
            logger.warn(`Skipping document ${doc.id} (${doc.slug}): not found`);
            return;
          }
          const slug = full.properties.slug ?? doc.slug;
          seen.add(slug);

          const rawHeaderImage = full.properties.headerImage ?? null;
          const [rewrittenContent, headerImageResult, rewrittenAssetProperties] =
            options.assetMode === "download"
              ? await Promise.all([
                  content
                    ? rewriteImages(content, client, assetsDir, urlCache, gate)
                    : null,
                  rawHeaderImage
                    ? downloadImage(rawHeaderImage, client, assetsDir, urlCache, gate)
                    : null,
                  Promise.all(
                    options.assetProperties.map(async (key) => {
                      const container = parseAssetContainer(full.properties[key]);
                      if (!container) return null;
                      const downloadIfAbsolute = async (url: string) => {
                        if (!isAbsoluteUrl(url)) return url;
                        const result = await downloadImage(url, client, assetsDir, urlCache, gate);
                        return result?.publicPath ?? url;
                      };
                      const rewritten = Array.isArray(container)
                        ? await Promise.all(container.map(downloadIfAbsolute))
                        : Object.fromEntries(
                            await Promise.all(
                              Object.entries(container).map(async ([entryKey, url]) => [
                                entryKey,
                                await downloadIfAbsolute(url),
                              ]),
                            ),
                          );
                      return [key, rewritten] as const;
                    }),
                  ),
                ])
              : [content, null, []];

          const properties = { ...full.properties };
          for (const entry of rewrittenAssetProperties) {
            if (entry && entry[0] in properties) properties[entry[0]] = JSON.stringify(entry[1]);
          }

          store.set({
            id: slug,
            digest: generateDigest({
              v: 11,
              id: doc.id,
              updatedAt: full.updatedAt,
              currentRev: full.currentRev,
              publishedRev: full.publishedRev,
              revision: options.revision,
              assetMode: options.assetMode,
            }),
            data: {
              docId: full.id,
              parentId: full.parentId,
              slug: full.slug,
              type: full.type ?? null,
              title: full.properties.title ?? null,
              headerImage:
                options.assetMode === "download"
                  ? (headerImageResult?.filename ?? null)
                  : rawHeaderImage,
              content: rewrittenContent,
              createdAt: full.createdAt,
              updatedAt: full.updatedAt,
              currentRev: full.currentRev,
              publishedRev: full.publishedRev,
              properties,
            },
          });
        }),
      );

      for (const key of store.keys()) {
        if (!seen.has(key)) store.delete(key);
      }

      if (options.assetMode === "remote") {
        meta.set("urlCache", JSON.stringify([]));
        logger.info(`Loaded ${selected.length} document(s).`);
        return;
      }

      // Build referencedFiles after all downloads complete.
      const referencedFiles = new Set(urlCache.values());

      for (const file of readdirSync(assetsDir)) {
        if (!referencedFiles.has(file)) rmSync(join(assetsDir, file));
      }

      for (const [url, filename] of urlCache) {
        if (!referencedFiles.has(filename)) urlCache.delete(url);
      }

      meta.set("urlCache", JSON.stringify([...urlCache]));
      logger.info(`Loaded ${selected.length} document(s).`);
    },
  };
}
