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

export interface Document {
  id: string;
  slug: string;
  type?: string | null;
  /** Present when fetching one document; omitted from document listings. */
  content?: string;
  currentRev: number;
  publishedRev: number | null;
  properties: Record<string, string>;
  parentId: string | null;
  readonly: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  mentionCount?: number;
  fileUrl?: string;
}

export interface Revision {
  rev: number;
  content: string;
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
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  documents: T[];
  total: number;
  limit: number;
  nextCursor?: string;
}

export interface ListDocumentsOptions {
  limit?: number;
  cursor?: string;
  type?: string;
  signal?: AbortSignal;
}

export interface PropertyFilter {
  key: string;
  value: string | null;
}

export interface SearchOptions {
  query?: string;
  limit?: number;
  offset?: number;
  filters?: PropertyFilter[];
  signal?: AbortSignal;
}

export interface SearchResult extends Document {
  rank: number;
  snippet: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  query: string;
  limit: number;
  offset: number;
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

  listSpaces(signal?: AbortSignal): Promise<Space[]> {
    return this.get("/api/v1/spaces", {}, signal);
  }

  listDocuments(
    spaceId: string,
    options: ListDocumentsOptions = {},
  ): Promise<Page<Document>> {
    const { signal, ...query } = options;
    return this.get(
      `/api/v1/spaces/${encodeURIComponent(spaceId)}/documents`,
      query,
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

  async getDocument(
    spaceId: string,
    documentId: string,
    signal?: AbortSignal,
  ): Promise<Document> {
    const response = await this.get<{ document: Document }>(
      `/api/v1/spaces/${encodeURIComponent(spaceId)}/documents/${encodeURIComponent(documentId)}`,
      {},
      signal,
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

  /** Finds a visible document by slug, then fetches its published content. */
  async getDocumentBySlug(
    spaceId: string,
    slug: string,
    options: { type?: string; signal?: AbortSignal } = {},
  ): Promise<Document | undefined> {
    const limit = 500;
    let offset = 0;
    do {
      const page = await this.listDocuments(spaceId, {
        limit,
        offset,
        type: options.type,
        signal: options.signal,
      });
      const match = page.documents.find((document) => document.slug === slug);
      if (match) return this.getDocument(spaceId, match.id, options.signal);
      offset += page.documents.length;
      if (page.documents.length === 0 || offset >= page.total) return undefined;
    } while (true);
  }

  async listCategories(spaceId: string, signal?: AbortSignal): Promise<Category[]> {
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
