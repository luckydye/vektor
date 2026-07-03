import type { APIRoute } from "astro";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  requireUser,
  verifyDocumentAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { getDocumentBySlug } from "#db/documents.ts";
import { getSpaceBySlug } from "#db/spaces.ts";
import { propertyValueToText } from "#utils/documentProperties.ts";
import { assertPublicUrl, SsrfError } from "#utils/ssrf.ts";

export interface LinkMetadata {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  video: string | null;
  siteName: string | null;
  favicon: string | null;
  updatedAt: string | null;
  fetchedAt: number;
}

interface CacheEntry {
  data: LinkMetadata;
  expiresAt: number;
}

// In-memory cache with TTL (10 minutes for external, 2 minutes for internal)
const EXTERNAL_CACHE_TTL_MS = 10 * 60 * 1000;
const INTERNAL_CACHE_TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, CacheEntry>();
const MAX_REDIRECTS = 3;

/** SSRF-validate a URL, translating violations into a 400 API response. */
async function validateExternalUrl(url: string): Promise<URL> {
  try {
    return await assertPublicUrl(url);
  } catch (error) {
    if (error instanceof SsrfError) {
      throw badRequestResponse(error.message);
    }
    throw error;
  }
}

function getCachedMetadata(key: string): LinkMetadata | null {
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }

  return entry.data;
}

function setCachedMetadata(key: string, data: LinkMetadata, ttl: number): void {
  cache.set(key, {
    data,
    expiresAt: Date.now() + ttl,
  });
}

function extractMetaContent(html: string, property: string): string | null {
  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
      "i",
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
      "i",
    ),
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }

  return null;
}

function extractTitle(html: string): string | null {
  const ogTitle = extractMetaContent(html, "og:title");
  if (ogTitle) return ogTitle;

  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return titleMatch ? titleMatch[1].trim() : null;
}

function extractFavicon(html: string, baseUrl: string): string | null {
  const patterns = [
    /<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i,
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i,
    /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']([^"']+)["']/i,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) {
      return resolveUrl(match[1], baseUrl);
    }
  }

  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}/favicon.ico`;
  } catch {
    return null;
  }
}

function resolveUrl(href: string, baseUrl: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }

  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

async function fetchExternalMetadata(url: string): Promise<LinkMetadata> {
  let target = await validateExternalUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    let response: Response | null = null;
    for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
      response = await fetch(target, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; WikiBot/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
        redirect: "manual",
      });

      const status = response.status;
      if (status >= 300 && status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Redirect missing location");
        }

        if (i === MAX_REDIRECTS) {
          throw new Error("Too many redirects");
        }

        const next = new URL(location, target);
        target = await validateExternalUrl(next.toString());
        continue;
      }

      break;
    }

    if (!response) {
      throw new Error("Failed to fetch URL");
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status}`);
    }

    const html = await response.text();

    const base = target.toString();
    return {
      url: base,
      title: extractTitle(html),
      description:
        extractMetaContent(html, "og:description") ||
        extractMetaContent(html, "description"),
      image: (() => {
        const img = extractMetaContent(html, "og:image");
        return img ? resolveUrl(img, base) : null;
      })(),
      video: (() => {
        const vid =
          extractMetaContent(html, "og:video") ||
          extractMetaContent(html, "og:video:url");
        return vid ? resolveUrl(vid, base) : null;
      })(),
      siteName: extractMetaContent(html, "og:site_name"),
      favicon: extractFavicon(html, base),
      updatedAt: null,
      fetchedAt: Date.now(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function extractDescriptionFromContent(content: string): string | null {
  const textContent = content
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!textContent) return null;

  if (textContent.length <= 160) return textContent;
  return `${textContent.slice(0, 157)}...`;
}

function isInternalUrl(url: string, siteUrl: string | undefined): boolean {
  if (!siteUrl) return false;

  try {
    const parsed = new URL(url);
    const site = new URL(siteUrl);
    return parsed.host === site.host;
  } catch {
    return false;
  }
}

function parseInternalPath(
  url: string,
): { spaceSlug: string; documentSlug: string } | null {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);

    if (pathParts.length < 2) return null;

    const spaceSlug = pathParts[0];

    // Handle /{spaceSlug}/doc/{documentSlug} format
    if (pathParts[1] === "doc" && pathParts[2]) {
      return { spaceSlug, documentSlug: pathParts[2] };
    }

    return null;
  } catch {
    return null;
  }
}

export const GET: APIRoute = (context) =>
  withApiErrorHandling(
    async () => {
      // This endpoint drives server-side fetches; require an authenticated user
      // so it cannot be used as an open SSRF-probing proxy by anonymous callers.
      requireUser(context);

      const url = context.url.searchParams.get("url");

      if (!url) {
        throw badRequestResponse("url parameter is required");
      }

      // Validate URL
      try {
        new URL(url);
      } catch {
        throw badRequestResponse("Invalid URL provided");
      }

      const siteUrl = context.url.origin;

      // Handle internal document links
      if (isInternalUrl(url, siteUrl)) {
        const internalPath = parseInternalPath(url);

        if (!internalPath) {
          throw badRequestResponse("Invalid internal URL path");
        }

        const cacheKey = `internal:${internalPath.spaceSlug}:${internalPath.documentSlug}`;

        const cached = getCachedMetadata(cacheKey);
        if (cached) {
          return jsonResponse(cached);
        }

        const space = await getSpaceBySlug(internalPath.spaceSlug);
        if (!space) {
          throw badRequestResponse("Space not found");
        }

        const doc = await getDocumentBySlug(space.id, internalPath.documentSlug);
        if (!doc) {
          throw badRequestResponse("Document not found");
        }

        const userId = context.locals.user?.id || null;
        try {
          await verifyDocumentAccess(space.id, doc.id, userId);
        } catch {
          throw badRequestResponse("Access denied");
        }

        const metadata: LinkMetadata = {
          url,
          title: doc.properties?.title
            ? propertyValueToText(doc.properties.title)
            : doc.slug,
          description: doc.content ? extractDescriptionFromContent(doc.content) : null,
          image: null,
          video: null,
          siteName: space.name,
          favicon: null,
          updatedAt: String(doc.updatedAt),
          fetchedAt: Date.now(),
        };

        setCachedMetadata(cacheKey, metadata, INTERNAL_CACHE_TTL_MS);
        return jsonResponse(metadata);
      }

      // Handle external URLs
      const cacheKey = `external:${url}`;

      const cached = getCachedMetadata(cacheKey);
      if (cached) {
        return jsonResponse(cached);
      }

      const metadata = await fetchExternalMetadata(url);
      setCachedMetadata(cacheKey, metadata, EXTERNAL_CACHE_TTL_MS);

      return jsonResponse(metadata);
    },
    {
      fallbackMessage: "Failed to fetch link preview",
      onError: (error) => {
        console.error("Link preview fetch error:", error);
        return errorResponse("Failed to fetch link preview", 500);
      },
    },
  );
