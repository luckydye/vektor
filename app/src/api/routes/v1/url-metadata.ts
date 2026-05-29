import type { APIRoute } from "astro";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  badRequestResponse,
  errorResponse,
  jsonResponse,
  verifyDocumentAccess,
  withApiErrorHandling,
} from "#db/api.ts";
import { getDocumentBySlug } from "#db/documents.ts";
import { getSpaceBySlug } from "#db/spaces.ts";

export interface LinkMetadata {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
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

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata"]);

const BLOCKED_IPS = new Set(["0.0.0.0", "127.0.0.1", "169.254.169.254", "::1"]);

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map((part) => Number.parseInt(part, 10));
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0;
}

function isIPv4InCidr(ip: string, cidr: string): boolean {
  const [range, maskBitsRaw] = cidr.split("/");
  const maskBits = Number.parseInt(maskBitsRaw, 10);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(range) & mask);
}

function expandIPv6(ip: string): string[] {
  if (ip.includes(".")) {
    const lastColon = ip.lastIndexOf(":");
    const prefix = ip.slice(0, lastColon);
    const v4 = ip.slice(lastColon + 1);
    const parts = v4.split(".").map((part) => Number.parseInt(part, 10));
    const high = ((parts[0] << 8) | parts[1]).toString(16);
    const low = ((parts[2] << 8) | parts[3]).toString(16);
    ip = `${prefix}:${high}:${low}`;
  }

  const [leftRaw, rightRaw] = ip.split("::");
  const left = leftRaw ? leftRaw.split(":").filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);
  const middle = Array.from({ length: Math.max(0, missing) }, () => "0");
  const parts = [...left, ...middle, ...right];
  return parts.map((part) => part.padStart(4, "0"));
}

function isIPv6InCidr(ip: string, cidr: string): boolean {
  const [rangeRaw, maskBitsRaw] = cidr.split("/");
  const maskBits = Number.parseInt(maskBitsRaw, 10);
  const ipParts = expandIPv6(ip);
  const rangeParts = expandIPv6(rangeRaw);

  let bitsRemaining = maskBits;
  for (let i = 0; i < 8; i += 1) {
    if (bitsRemaining <= 0) return true;

    const partMaskBits = Math.min(16, bitsRemaining);
    const mask = partMaskBits === 0 ? 0 : (0xffff << (16 - partMaskBits)) & 0xffff;
    const ipPart = Number.parseInt(ipParts[i], 16);
    const rangePart = Number.parseInt(rangeParts[i], 16);

    if ((ipPart & mask) !== (rangePart & mask)) {
      return false;
    }

    bitsRemaining -= 16;
  }

  return true;
}

function isPrivateOrBlockedIp(ip: string): boolean {
  if (BLOCKED_IPS.has(ip)) return true;

  if (isIP(ip) === 4) {
    const blockedCidrs = [
      "10.0.0.0/8",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "172.16.0.0/12",
      "192.168.0.0/16",
      "100.64.0.0/10",
      "198.18.0.0/15",
      "224.0.0.0/4",
      "240.0.0.0/4",
    ];
    return blockedCidrs.some((cidr) => isIPv4InCidr(ip, cidr));
  }

  if (isIP(ip) === 6) {
    const normalized = ip.toLowerCase();
    const blockedCidrs = ["::1/128", "fc00::/7", "fe80::/10", "ff00::/8"];
    return blockedCidrs.some((cidr) => isIPv6InCidr(normalized, cidr));
  }

  return true;
}

async function validateExternalUrl(url: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw badRequestResponse("Invalid URL provided");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw badRequestResponse("Only HTTP(S) URLs are allowed");
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".internal")) {
    throw badRequestResponse("URL host is not allowed");
  }

  if (isIP(hostname) && isPrivateOrBlockedIp(hostname)) {
    throw badRequestResponse("URL host is not allowed");
  }

  try {
    const records = await lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0) {
      throw badRequestResponse("Unable to resolve URL host");
    }

    for (const record of records) {
      if (isPrivateOrBlockedIp(record.address)) {
        throw badRequestResponse("URL host is not allowed");
      }
    }
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    throw badRequestResponse("Unable to resolve URL host");
  }

  return parsed;
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

    return {
      url: target.toString(),
      title: extractTitle(html),
      description:
        extractMetaContent(html, "og:description") ||
        extractMetaContent(html, "description"),
      image: (() => {
        const img = extractMetaContent(html, "og:image");
        return img ? resolveUrl(img, target.toString()) : null;
      })(),
      siteName: extractMetaContent(html, "og:site_name"),
      favicon: extractFavicon(html, target.toString()),
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
  return textContent.slice(0, 157) + "...";
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
          title: doc.properties?.title || doc.slug,
          description: doc.content ? extractDescriptionFromContent(doc.content) : null,
          image: null,
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
