export const DEFAULT_VEKTOR_URL = "http://localhost:8080";

export interface VektorClientOptions {
  /** Vektor origin. Defaults to http://localhost:8080. */
  baseUrl?: string;
  /** Access token created in Vektor. Sent as a Bearer token. */
  accessToken?: string;
  /** Extra headers included with every request. */
  headers?: HeadersInit;
  /** Fetch implementation, useful for tests or non-standard runtimes. */
  fetch?: typeof globalThis.fetch;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  preferences: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  userRole?: string;
  memberCount?: number;
}

/**
 * A property holds either a single value or a multi-value list. Vektor decides
 * per value, so any property can come back either way — use `propertyText` or
 * `propertyScalar` instead of assuming a string.
 */
export type PropertyValue = string | string[];

/** Renders a property as display text, joining multi-value lists with commas. */
export function propertyText(value: PropertyValue): string {
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Takes the single (or first) value of a property. */
export function propertyScalar(
  value: PropertyValue | null | undefined,
): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value ?? undefined;
}

export interface Document {
  id: string;
  slug: string;
  type?: string | null;
  /** Present when fetching one document; omitted from document listings. */
  content?: string;
  currentRev: number;
  publishedRev: number | null;
  properties: Record<string, PropertyValue>;
  parentId: string | null;
  readonly: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  mentionCount?: number;
  /** Width / height of the `headerImage` property. Only on a single-document fetch. */
  headerImageAspectRatio?: number | null;
  /** Set on uploaded-file entries — fetch this URL instead of the document route. */
  fileUrl?: string;
}

export interface Revision {
  id: string;
  documentId: string;
  rev: number;
  slug: string;
  content: string;
  checksum: string;
  parentRev: number | null;
  /** "suggestion" for proposed edits; null for an ordinary revision. */
  status?: string | null;
  message?: string | null;
  createdAt: string;
  createdBy: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  /** Sort position within the space; listings arrive already ordered by it. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  documents: T[];
  total: number;
  /** The page size that was applied. Absent when the response is unpaginated. */
  limit?: number;
  /** Null on the last page. Pass it back as `cursor` to read the next one. */
  nextCursor: string | null;
}

export interface ListDocumentsOptions {
  /** Server default is 50, capped at 500. */
  limit?: number;
  cursor?: string;
  type?: string;
  categorySlugs?: string[];
  /** List the children of one document instead of the whole space. Unpaginated. */
  parentId?: string;
  /**
   * Append the space's uploaded files as `type: "file"` entries carrying a
   * `fileUrl`. The file index is unpaginated and ships in full on the first
   * page, so only ask for it when the listing actually needs files.
   */
  includeFiles?: boolean;
  signal?: AbortSignal;
}

/** The abbreviated space a single-document response is served from. */
export interface SpaceRef {
  id: string;
  slug: string;
  name: string;
}

export interface GetDocumentOptions {
  /**
   * Read the current draft instead of the published revision. Requires editor
   * permission — a viewer-scoped token gets 403.
   */
  draft?: boolean;
  signal?: AbortSignal;
}

export interface PropertyFilter {
  key: string;
  value: string | null;
}

export interface SearchOptions {
  query?: string;
  /** Server default is 20, capped at 100. */
  limit?: number;
  cursor?: string;
  filters?: PropertyFilter[];
  signal?: AbortSignal;
}

export interface SearchResult extends Document {
  rank: number;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  nextCursor?: string | null;
  query: string;
  /** Omitted from the empty response returned when there is no query and no filter. */
  limit?: number;
  filters: PropertyFilter[];
}

export class VektorApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: unknown;

  constructor(status: number, url: string, body: unknown) {
    const detail =
      typeof body === "object" && body !== null && "error" in body
        ? String(body.error)
        : typeof body === "string" && body
          ? body
          : `HTTP ${status}`;
    super(`Vektor API request failed: ${detail}`);
    this.name = "VektorApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function addQuery(url: URL, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value));
    }
  }
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** A small, GET-only client intended for content sites and server rendering. */
export class VektorClient {
  readonly baseUrl: string;
  private readonly accessToken?: string;
  private readonly headers: Headers;
  private readonly fetcher: typeof globalThis.fetch;

  constructor(options: VektorClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_VEKTOR_URL);
    this.accessToken = options.accessToken;
    this.headers = new Headers(options.headers);
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  async fetchUrl(url: string, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(this.headers);
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);
    return this.fetcher(url, { method: "GET", headers, signal });
  }

  private async get<T>(
    path: string,
    query: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    addQuery(url, query);
    const headers = new Headers(this.headers);
    headers.set("Accept", "application/json");
    if (this.accessToken) headers.set("Authorization", `Bearer ${this.accessToken}`);

    const response = await this.fetcher(url, { method: "GET", headers, signal });
    const body = await responseBody(response);
    if (!response.ok) throw new VektorApiError(response.status, url.toString(), body);
    return body as T;
  }

  /** Whether the server deliberately presents a missing or private document as absent. */
  private isNotVisible(status: number): boolean {
    return status === 404;
  }

  listSpaces(signal?: AbortSignal): Promise<Space[]> {
    return this.get("/api/v1/spaces", {}, signal);
  }

  listDocuments(
    spaceId: string,
    options: ListDocumentsOptions = {},
  ): Promise<Page<Document>> {
    const { signal, categorySlugs, ...query } = options;
    return this.get(
      `/api/v1/spaces/${encodeURIComponent(spaceId)}/documents`,
      { ...query, categorySlugs: categorySlugs?.join(",") },
      signal,
    );
  }

  async listDocumentsByCategories(
    spaceId: string,
    categorySlugs: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, Document[]>> {
    const response = await this.get<{
      documentsByCategory: Record<string, Document[]>;
    }>(
      `/api/v1/spaces/${encodeURIComponent(spaceId)}/documents`,
      { categorySlugs: categorySlugs.join(","), grouped: true },
      signal,
    );
    return response.documentsByCategory;
  }

  /** Accepts a document id or a slug, and a space id or a space slug. */
  async getDocument(
    spaceId: string,
    documentId: string,
    options: GetDocumentOptions = {},
  ): Promise<Document> {
    const response = await this.get<{ document: Document; space: SpaceRef }>(
      `/api/v1/spaces/${encodeURIComponent(spaceId)}/documents/${encodeURIComponent(documentId)}`,
      { draft: options.draft ? "true" : undefined },
      options.signal,
    );
    return response.document;
  }

  async getRevision(
    spaceId: string,
    documentId: string,
    rev: number,
    signal?: AbortSignal,
  ): Promise<Revision> {
    const response = await this.get<{ revision: Revision }>(
      `/api/v1/spaces/${encodeURIComponent(spaceId)}/documents/${encodeURIComponent(documentId)}`,
      { rev },
      signal,
    );
    return response.revision;
  }

  /**
   * Fetches a visible document by slug, or undefined when no such document is
   * visible. Archived documents are treated as absent.
   */
  async getDocumentBySlug(
    spaceId: string,
    slug: string,
    options: GetDocumentOptions & { type?: string } = {},
  ): Promise<Document | undefined> {
    let document: Document;
    try {
      // The document route resolves a slug as well as an id, so this is one request.
      document = await this.getDocument(spaceId, slug, options);
    } catch (error) {
      if (error instanceof VektorApiError && this.isNotVisible(error.status)) {
        return undefined;
      }
      throw error;
    }
    if (document.archived) return undefined;
    if (options.type && document.type !== options.type) return undefined;
    return document;
  }

  async listCategories(spaceId: string, signal?: AbortSignal): Promise<Category[]> {
    // The response also carries `hasHiddenCategories`, which only distinguishes
    // empty-space from nothing-visible-to-you for the Vektor UI's empty states.
    const response = await this.get<{ categories: Category[] }>(
      `/api/v1/spaces/${encodeURIComponent(spaceId)}/categories`,
      {},
      signal,
    );
    return response.categories;
  }

  search(spaceId: string, options: SearchOptions = {}): Promise<SearchResponse> {
    const { signal, query, filters, ...pagination } = options;
    return this.get(
      `/api/v1/spaces/${encodeURIComponent(spaceId)}/search`,
      {
        q: query,
        filters: filters ? JSON.stringify(filters) : undefined,
        ...pagination,
      },
      signal,
    );
  }
}

export function createVektorClient(options: VektorClientOptions = {}): VektorClient {
  return new VektorClient(options);
}
