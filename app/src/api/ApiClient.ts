export interface User {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  preferences: Record<string, string>;
  createdAt: Date | string;
  updatedAt: Date | string;
  userRole?: string;
  memberCount?: number;
}

export interface SpaceMember {
  userId?: string;
  groupId?: string;
  role: string;
  joinedAt: Date | string;
  user?: User;
}

export interface Document {
  id: string;
  slug: string;
  type?: string | null;
  content: string;
  currentRev: number;
  publishedRev: number | null;
  readonly?: boolean;
  parentId?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  createdBy: string;
  updatedBy: string;
}

export interface DocumentWithProperties extends Document {
  properties: Record<string, string>;
  mentionCount?: number;
}

export interface DocumentMember {
  documentId: string;
  userId: string;
  role: string;
  grantedAt: Date | string;
  grantedBy: string;
  user?: User;
}

export interface DocumentContributor {
  userId: string;
  name: string;
  email: string;
  image?: string | null;
  contributionCount: number;
  lastContribution: Date | string;
}

export interface Revision {
  id: string;
  documentId: string;
  rev: number;
  slug: string;
  checksum: string;
  parentRev: number | null;
  message: string | null;
  createdAt: Date | string;
  createdBy: string;
}

export interface RevisionWithContent extends Revision {
  content: string;
}

export interface RevisionMetadata {
  id: string;
  documentId: string;
  rev: number;
  slug: string;
  checksum: string;
  parentRev: number | null;
  message: string | null;
  createdAt: Date | string;
  createdBy: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string;
  color?: string;
  icon?: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface Connection {
  id: string;
  label: string;
  url?: string;
  icon?: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type WebhookEvent =
  | "document.published"
  | "document.unpublished"
  | "document.deleted"
  | "mention";

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  documentId?: string | null;
  enabled: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
  createdBy: string;
}

export interface ExtensionRouteMenuItem {
  title: string;
  icon?: string;
}

export interface ExtensionRoute {
  path: string;
  title?: string;
  description?: string;
  menuItem?: ExtensionRouteMenuItem;
  /** Where this view should be placed. Can include "page" (default) and/or home placements */
  placements?: Array<"page" | "home-top">;
}

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  entries: {
    frontend?: string;
    view?: string;
  };
  routes?: ExtensionRoute[];
  createdAt: Date | string;
  updatedAt: Date | string;
  createdBy: string;
}

export interface AccessToken {
  id: string;
  name: string;
  expiresAt: Date | string | null;
  lastUsedAt: Date | string | null;
  createdAt: Date | string;
  createdBy: string;
  revokedAt: Date | string | null;
  resources?: Array<{
    resourceType: string;
    resourceId: string;
    permission: string;
  }>;
}

export type AuditEvent =
  | "view"
  | "save"
  | "publish"
  | "unpublish"
  | "restore"
  | "delete"
  | "acl_grant"
  | "acl_revoke"
  | "create"
  | "lock"
  | "unlock"
  | "property_update"
  | "property_delete"
  | "webhook_success"
  | "webhook_failed";

export interface AuditDetails {
  ip?: string;
  userAgent?: string;
  referrer?: string;
  message?: string;
  previousValue?: string;
  newValue?: string;
  permission?: string;
  propertyKey?: string;
  propertyType?: string;
  webhookId?: string;
  webhookUrl?: string;
  webhookEvent?: string;
  statusCode?: number;
  errorMessage?: string;
}

export interface AuditLog {
  id: string;
  docId: string;
  revisionId?: number | null;
  userId?: string | null;
  event: AuditEvent;
  details?: AuditDetails | null;
  createdAt: Date | string;
  userName?: string | null;
}

export interface PropertyInfo {
  name: string;
  type: string | null;
  values: string[];
}

// Property filter for advanced search
// Use value: null to filter for documents that have the property (any value)
// Use value: string to filter for documents with that specific property value
export interface PropertyFilter {
  key: string;
  value: string | null;
}

export interface SearchResult {
  id: string;
  slug: string;
  content: string;
  properties: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  userId: string;
  parentId: string | null;
  rank: number;
  snippet: string;
}

export interface Comment {
  id: string;
  documentId: string;
  content: string;
  reference: string | null;
  parentId: string | null;
  type: string;
  createdAt: Date | string;
  createdBy: string;
  updatedAt: Date | string;
  updatedBy: string;
  createdByUser?: {
    id: string;
    name: string | null;
    email: string;
    image: string | null;
  } | null;
}

/**
 * Main API client class with fluent interface
 * @example
 * const api = new ApiClient();
 * const users = await api.users.get();
 * const document = await api.document.get("space-123", "doc-456");
 */
export class ApiClient {
  baseUrl: string;
  accessToken?: string;
  socketHost?: string;

  constructor(options: {
    baseUrl: string;
    accessToken?: string;
    socketHost?: string;
  }) {
    this.baseUrl = options.baseUrl;
    this.accessToken = options.accessToken;
    this.socketHost = options?.socketHost;
  }

  /**
   * Base fetch function with error handling
   */
  async apiFetch<T>(
    base: string,
    path: string,
    options?: {
      query?: Record<string, string | number | boolean | undefined | null>;
    } & RequestInit,
  ): Promise<T> {
    const { query, ...fetchOptions } = options || {};

    let finalUrl = `${base}${path}`;
    if (query) {
      const searchParams = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      }
      const queryString = searchParams.toString();
      if (queryString) {
        finalUrl = `${base}${path}?${queryString}`;
      }
    }

    const response = await fetch(finalUrl, {
      ...fetchOptions,
      headers: {
        ...fetchOptions.headers,
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {})
      }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`API request failed: ${response.status} ${error}`);
    }

    return response.json();
  }

  /**
   * Type-safe GET request
   */
  async apiGet<T>(
    base: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T> {
    return this.apiFetch<T>(base, path, { method: "GET", query });
  }

  /**
   * Type-safe POST request
   */
  async apiPost<T>(
    base: string,
    path: string,
    body?: unknown,
    options?: {
      query?: Record<string, string | number | boolean | undefined | null>;
    } & RequestInit,
  ): Promise<T> {
    return this.apiFetch<T>(base, path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });
  }

  /**
   * Type-safe PUT request
   */
  async apiPut<T, TBody = unknown>(
    base: string,
    path: string,
    body?: TBody,
    options?: {
      query?: Record<string, string | number | boolean | undefined | null>;
    } & RequestInit,
  ): Promise<T> {
    return this.apiFetch<T>(base, path, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });
  }

  /**
   * Type-safe PATCH request
   */
  async apiPatch<T, TBody = unknown>(
    base: string,
    path: string,
    body?: TBody,
    options?: {
      query?: Record<string, string | number | boolean | undefined | null>;
    } & RequestInit,
  ): Promise<T> {
    return this.apiFetch<T>(base, path, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      ...options,
    });
  }

  /**
   * Type-safe DELETE request
   */
  async apiDelete(
    base: string,
    path: string,
    options?: {
      query?: Record<string, string | number | boolean | undefined | null>;
    } & RequestInit,
  ): Promise<void> {
    await this.apiFetch<void>(base, path, {
      method: "DELETE",
      ...options,
    });
  }

  users = {
    /**
     * List all users
     */
    get: async () => {
      return await this.apiGet<User[]>(this.baseUrl, "/api/v1/users");
    },
    /**
     * Get a user by ID
     */
    getById: async (id: string) => {
      return await this.apiGet<User>(this.baseUrl, `/api/v1/users?id=${encodeURIComponent(id)}`);
    },
  };

  spaces = {
    /**
     * List all spaces
     */
    get: async () => {
      return await this.apiGet<Space[]>(this.baseUrl, "/api/v1/spaces");
    },

    /**
     * Create a new space
     */
    post: async (body: {
      name: string;
      slug: string;
      preferences?: Record<string, string>;
    }) => {
      const response = await this.apiPost<{ space: Space }>(this.baseUrl, "/api/v1/spaces", body);
      return response.space;
    },
  };

  space = {
    /**
     * Get a space by ID
     */
    get: async (spaceId: string) => {
      return await this.apiGet<Space>(this.baseUrl, `/api/v1/spaces/${spaceId}`);
    },

    /**
     * Update a space
     */
    put: async (
      spaceId: string,
      body: { name?: string; slug?: string; preferences?: Record<string, string> },
    ) => {
      return await this.apiPut<Space>(this.baseUrl, `/api/v1/spaces/${spaceId}`, body);
    },

    /**
     * Delete a space
     */
    delete: async (spaceId: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}`);
    },
  };

  spaceMembers = {
    /**
     * List members in a space
     */
    get: async (spaceId: string) => {
      return await this.apiGet<SpaceMember[]>(this.baseUrl, `/api/v1/spaces/${spaceId}/members`);
    },
  };

  permissions = {
    /**
     * Get current user's permissions (role + features + groups)
     */
    getMe: async (spaceId: string) => {
      return await this.apiGet<{
        role: string | null;
        features: Record<string, boolean>;
        groups: string[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/permissions/me`);
    },

    /**
     * List all permissions in space (roles + features)
     */
    list: async (spaceId: string, type?: "role" | "feature" | "all") => {
      const url =
        type && type !== "all"
          ? `/api/v1/spaces/${spaceId}/permissions?type=${type}`
          : `/api/v1/spaces/${spaceId}/permissions`;
      return await this.apiGet<{
        permissions: Array<{
          type: "role" | "feature";
          permission: any;
        }>;
      }>(this.baseUrl, url);
    },

    /**
     * Grant a permission (role or feature) to user or group
     */
    grant: async (
      spaceId: string,
      body: {
        type: "role" | "feature";
        roleOrFeature: string;
        userId?: string;
        groupId?: string;
      },
    ) => {
      return await this.apiPost(this.baseUrl, `/api/v1/spaces/${spaceId}/permissions`, {
        ...body,
        action: "grant",
      });
    },

    /**
     * Deny a feature (feature only) for user or group
     */
    deny: async (
      spaceId: string,
      body: {
        roleOrFeature: string;
        userId?: string;
        groupId?: string;
      },
    ) => {
      return await this.apiPost(this.baseUrl, `/api/v1/spaces/${spaceId}/permissions`, {
        type: "feature",
        ...body,
        action: "deny",
      });
    },

    /**
     * Revoke a permission (role or feature) from user or group
     */
    revoke: async (
      spaceId: string,
      body: {
        type: "role" | "feature";
        roleOrFeature: string;
        userId?: string;
        groupId?: string;
      },
    ) => {
      return await this.apiPost(this.baseUrl, `/api/v1/spaces/${spaceId}/permissions`, {
        ...body,
        action: "revoke",
      });
    },
  };

  categories = {
    /**
     * List categories in a space
     */
    get: async (spaceId: string) => {
      const response = await this.apiGet<{ categories: Category[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/categories`,
      );
      return response.categories;
    },

    /**
     * Create a new category
     */
    post: async (
      spaceId: string,
      body: {
        name: string;
        slug: string;
        description?: string;
        color?: string;
        icon?: string;
      },
    ) => {
      const response = await this.apiPost<{ category: Category }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/categories`,
        body,
      );
      return response.category;
    },

    /**
     * List documents in a category
     */
    documents: async (spaceId: string, slug: string) => {
      const response = await this.apiGet<{ documents: DocumentWithProperties[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/categories/${slug}/documents`,
      );
      return response.documents;
    },

    /**
     * Reorder categories
     */
    reorder: async (spaceId: string, categoryIds: string[]) => {
      const response = await this.apiPut<{ success: boolean }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/categories`,
        { categoryIds },
      );
      return response.success;
    },
  };

  category = {
    /**
     * Get a category by ID
     */
    get: async (spaceId: string, id: string) => {
      const response = await this.apiGet<{ category: Category }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/categories/${id}`,
      );
      return response.category;
    },

    /**
     * Update a category
     */
    put: async (
      spaceId: string,
      id: string,
      body: {
        name?: string;
        slug?: string;
        description?: string;
        color?: string;
        icon?: string;
      },
    ) => {
      const response = await this.apiPut<{ category: Category }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/categories/${id}`,
        body,
      );
      return response.category;
    },

    /**
     * Delete a category
     */
    delete: async (spaceId: string, id: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/categories/${id}`);
    },
  };

  documents = {
    /**
     * List documents in a space
     */
    get: async (spaceId: string, query?: Record<string, string | number | boolean>) => {
      const response = await this.apiGet<{
        documents: DocumentWithProperties[];
        total: number;
        limit: number;
        offset: number;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents`, query);
      return response;
    },

    /**
     * Create a new document
     */
    post: async (
      spaceId: string,
      body: {
        slug?: string;
        type?: string;
        content: string;
        parentId?: string | null;
        categoryId?: string | null;
        properties?: Record<string, any>;
      },
    ) => {
      const response = await this.apiPost<{ document: DocumentWithProperties }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents`,
        body,
      );
      return response.document;
    },
  };

  document = {
    /**
     * Get a document by ID
     */
    get: async (spaceId: string, documentId: string, query?: { rev?: number }) => {
      if (query?.rev) {
        const response = await this.apiGet<{ revision: RevisionWithContent }>(
          this.baseUrl,
          `/api/v1/spaces/${spaceId}/documents/${documentId}`,
          query,
        );
        return response.revision as unknown as DocumentWithProperties;
      }
      const response = await this.apiGet<{ document: DocumentWithProperties }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}`,
        query,
      );
      return response.document;
    },

    /**
     * Update document content (PUT)
     */
    put: async (spaceId: string, documentId: string, content: string) => {
      const response = await fetch(`/api/v1/spaces/${spaceId}/documents/${documentId}`, {
        method: "PUT",
        headers: {
          "Content-Type": "text/html",
        },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed: ${response.status} ${error}`);
      }

      const data = (await response.json()) as { document: DocumentWithProperties };
      return data.document;
    },

    /**
     * Patch document properties
     */
    patch: async (
      spaceId: string,
      documentId: string,
      body: {
        parentId?: string | null;
        publishedRev?: number | null;
        readonly?: boolean;
      },
    ) => {
      return await this.apiPatch(this.baseUrl, `/api/v1/spaces/${spaceId}/documents/${documentId}`, body);
    },

    /**
     * Archive a document
     */
    archive: async (spaceId: string, documentId: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/documents/${documentId}`);
    },

    /**
     * Delete a document permanently
     */
    delete: async (spaceId: string, documentId: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/documents/${documentId}?permanent=true`);
    },

    /**
     * Save a revision (POST to document endpoint)
     */
    post: async (
      spaceId: string,
      documentId: string,
      body: { html: string; message?: string },
    ) => {
      const response = await this.apiPost<{ revision: Revision }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}`,
        body,
      );
      return response.revision;
    },
  };

  documentHistory = {
    /**
     * Get revision history for a document
     */
    get: async (spaceId: string, documentId: string) => {
      const response = await this.apiGet<{ revisions: RevisionMetadata[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/revisions`,
      );
      return response.revisions;
    },
  };

  documentAuditLogs = {
    /**
     * Get audit logs for a document
     */
    get: async (spaceId: string, documentId: string, query?: { limit?: number }) => {
      const response = await this.apiGet<{ auditLogs: AuditLog[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/audit-logs`,
        query,
      );
      return response.auditLogs;
    },
  };

  documentContributors = {
    /**
     * Get contributors for a document
     */
    get: async (spaceId: string, documentId: string) => {
      const response = await this.apiGet<{ contributors: DocumentContributor[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/contributors`,
      );
      return response.contributors;
    },
  };

  documentChildren = {
    /**
     * Get child documents
     */
    get: async (spaceId: string, documentId: string) => {
      const response = await this.apiGet<{ children: DocumentWithProperties[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/children`,
      );
      return response.children;
    },
  };

  documentProperty = {
    /**
     * Set a document property
     */
    put: async (
      spaceId: string,
      documentId: string,
      body: { key: string; value: string; type?: string | null },
    ) => {
      return await this.apiPut<{
        slug?: string;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents/${documentId}/property`, body);
    },

    /**
     * Delete a document property
     */
    delete: async (spaceId: string, documentId: string, key: string) => {
      const response = await fetch(
        `/api/v1/spaces/${spaceId}/documents/${documentId}/property`,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ key }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed: ${response.status} ${error}`);
      }
    },
  };

  documentPublish = {
    /**
     * Restore a document to a specific revision
     */
    post: async (spaceId: string, documentId: string, rev: number) => {
      await this.apiPost(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/publish?rev=${rev}`,
        {},
      );
    },
  };

  drafts = {
    /**
     * List draft documents in a space (with pagination)
     */
    get: async (spaceId: string, query?: Record<string, string | number | boolean>) => {
      const response = await this.apiGet<{
        documents: DocumentWithProperties[];
        total: number;
        limit: number;
        offset: number;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/drafts`, query);
      return response;
    },
  };

  search = {
    /**
     * Search documents in a space
     *
     * @param spaceId - The space to search in
     * @param query.q - Search query text (can be empty when using filters only)
     * @param query.limit - Max results to return
     * @param query.offset - Pagination offset
     * @param query.filters - Property filters as JSON string: [{"key":"author","value":"John"}]
     *                        Use value: null to filter for documents that have the property
     */
    get: async (
      spaceId: string,
      query: { q?: string; limit?: number; offset?: number; filters?: string },
    ) => {
      const response = await this.apiGet<{
        results: SearchResult[];
        total: number;
        query: string;
        limit: number;
        offset: number;
        filters?: PropertyFilter[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/search`, query);
      return response;
    },

    /**
     * Rebuild search index
     */
    rebuild: async (spaceId: string) => {
      await this.apiPost(this.baseUrl, `/api/v1/spaces/${spaceId}/search/rebuild`, {});
    },
  };

  properties = {
    /**
     * List properties in a space
     */
    get: async (spaceId: string) => {
      const response = await this.apiGet<{ properties: PropertyInfo[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/properties`,
      );
      return response.properties;
    },
  };

  auditLogs = {
    /**
     * List audit logs for a space
     */
    get: async (spaceId: string, query?: { limit?: number }) => {
      const response = await this.apiGet<{ auditLogs: AuditLog[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/audit-logs`,
        query,
      );
      return response.auditLogs;
    },
  };

  uploads = {
    /**
     * List uploads in a space
     */
    get: async (spaceId: string) => {
      await this.apiGet(this.baseUrl, `/api/v1/spaces/${spaceId}/uploads`);
    },

    /**
     * Create/upload a file
     * @param spaceId - The space ID
     * @param file - The file to upload
     * @param filename - Optional filename override
     * @param documentId - Optional document ID to scope the upload to
     */
    post: async (
      spaceId: string,
      file: File | Blob,
      filename?: string,
      documentId?: string,
    ) => {
      const formData = new FormData();
      formData.append("file", file, filename);
      if (documentId) {
        formData.append("documentId", documentId);
      }

      const response = await fetch(`/api/v1/spaces/${spaceId}/uploads`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Upload failed: ${response.status} ${error}`);
      }

      return await response.json();
    },
  };

  upload = {
    /**
     * Get an upload by filename
     */
    get: async (spaceId: string, filename: string) => {
      const response = await this.apiGet<{ url: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/uploads/${filename}`,
      );
      return response.url;
    },

    /**
     * Delete an upload
     */
    delete: async (spaceId: string, filename: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/uploads/${filename}`);
    },
  };

  import = {
    /**
     * Import data into a space
     */
    post: async (spaceId: string, file: File | Blob) => {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`/api/v1/spaces/${spaceId}/import`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Import failed: ${response.status} ${error}`);
      }

      return await response.json();
    },
  };

  accessTokens = {
    /**
     * List access tokens in a space
     */
    get: async (spaceId: string) => {
      return await this.apiGet<{ tokens: AccessToken[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens`,
      );
    },

    /**
     * Get a specific access token
     */
    getById: async (spaceId: string, tokenId: string) => {
      return await this.apiGet<{ token: AccessToken }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens/${tokenId}`,
      );
    },

    /**
     * Create a new access token
     */
    create: async (
      spaceId: string,
      body: {
        name: string;
        resourceType: string;
        resourceId: string;
        permission: string;
        expiresInDays?: number;
      },
    ) => {
      return await this.apiPost<{
        id: string;
        token: string;
        resources: any[];
        message: string;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/access-tokens`, body);
    },

    /**
     * Revoke an access token
     */
    revoke: async (spaceId: string, tokenId: string) => {
      return await this.apiPatch<{ message: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens/${tokenId}`,
        {},
      );
    },

    /**
     * Delete an access token
     */
    delete: async (spaceId: string, tokenId: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/access-tokens/${tokenId}`);
    },
  };

  webhooks = {
    /**
     * List webhooks in a space
     */
    get: async (spaceId: string) => {
      return await this.apiGet<{ webhooks: Webhook[] }>(this.baseUrl, `/api/v1/spaces/${spaceId}/webhooks`);
    },

    /**
     * Get a specific webhook
     */
    getById: async (spaceId: string, webhookId: string) => {
      return await this.apiGet<{ webhook: Webhook }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/webhooks/${webhookId}`,
      );
    },

    /**
     * Create a new webhook
     */
    post: async (
      spaceId: string,
      body: { url: string; events: WebhookEvent[]; documentId?: string; secret?: string },
    ) => {
      return await this.apiPost<{ webhook: Webhook }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/webhooks`,
        body,
      );
    },

    /**
     * Update a webhook
     */
    patch: async (
      spaceId: string,
      webhookId: string,
      body: {
        url?: string;
        events?: WebhookEvent[];
        documentId?: string;
        secret?: string;
        enabled?: boolean;
      },
    ) => {
      return await this.apiPatch<{ webhook: Webhook }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/webhooks/${webhookId}`,
        body,
      );
    },

    /**
     * Delete a webhook
     */
    delete: async (spaceId: string, webhookId: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/webhooks/${webhookId}`);
    },
  };

  extensions = {
    /**
     * List all extensions in a space
     */
    get: async (spaceId: string): Promise<ExtensionInfo[]> => {
      return await this.apiGet<ExtensionInfo[]>(this.baseUrl, `/api/v1/spaces/${spaceId}/extensions`);
    },

    /**
     * Get a single extension
     */
    getById: async (spaceId: string, extensionId: string): Promise<ExtensionInfo> => {
      return await this.apiGet<ExtensionInfo>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/extensions/${extensionId}`,
      );
    },

    /**
     * Upload an extension (zip file)
     */
    upload: async (spaceId: string, file: File | Blob): Promise<ExtensionInfo> => {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`/api/v1/spaces/${spaceId}/extensions`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(error.error || `Upload failed: ${response.status}`);
      }

      return await response.json();
    },

    /**
     * Delete an extension
     */
    delete: async (spaceId: string, extensionId: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/extensions/${extensionId}`);
    },

    /**
     * Extension storage operations
     */
    storage: {
      /**
       * Get a storage value
       */
      get: async (
        spaceId: string,
        extensionId: string,
        key: string,
      ): Promise<{ key: string; value: string } | null> => {
        try {
          return await this.apiGet<{ key: string; value: string }>(
            this.baseUrl,
            `/api/v1/spaces/${spaceId}/extensions/${extensionId}/storage/${encodeURIComponent(key)}`,
          );
        } catch {
          return null;
        }
      },

      /**
       * Set a storage value
       */
      set: async (
        spaceId: string,
        extensionId: string,
        key: string,
        value: string,
      ): Promise<{ key: string; value: string; updatedAt: string }> => {
        return await this.apiPut<{ key: string; value: string; updatedAt: string }>(
          this.baseUrl,
          `/api/v1/spaces/${spaceId}/extensions/${extensionId}/storage/${encodeURIComponent(key)}`,
          { value },
        );
      },

      /**
       * Delete a storage value
       */
      delete: async (
        spaceId: string,
        extensionId: string,
        key: string,
      ): Promise<void> => {
        await this.apiDelete(
          this.baseUrl,
          `/api/v1/spaces/${spaceId}/extensions/${extensionId}/storage/${encodeURIComponent(key)}`,
        );
      },

      /**
       * List all storage entries, optionally filtered by prefix
       */
      list: async (
        spaceId: string,
        extensionId: string,
        prefix?: string,
      ): Promise<
        Array<{ key: string; value: string; createdAt: string; updatedAt: string }>
      > => {
        const params = prefix ? { prefix } : undefined;
        return await this.apiGet<
          Array<{ key: string; value: string; createdAt: string; updatedAt: string }>
        >(this.baseUrl, `/api/v1/spaces/${spaceId}/extensions/${extensionId}/storage`, params);
      },
    },
  };

  /**
   * Fetch preview metadata for a URL
   * @example
   * const metadata = await api.linkPreview.get("https://example.com");
   * console.log(metadata.title, metadata.description, metadata.image);
   */
  linkPreview = {
    get: async (
      url: string,
    ): Promise<{
      url: string;
      title: string | null;
      description: string | null;
      image: string | null;
      siteName: string | null;
      favicon: string | null;
      updatedAt: string | null;
      fetchedAt: number;
    }> => {
      return await this.apiGet(this.baseUrl, `/api/v1/url-metadata`, { url });
    },
  };

  documentComments = {
    /**
     * Get all comments for a document
     */
    get: async (spaceId: string, documentId: string) => {
      const response = await this.apiGet<{ comments: Comment[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/comments`,
      );
      return response.comments;
    },

    /**
     * Create a new comment
     */
    post: async (
      spaceId: string,
      documentId: string,
      body: {
        content: string;
        parentId: string | null;
        reference: string | null;
        type: string;
      },
    ) => {
      const response = await this.apiPost<{ comment: Comment }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/comments`,
        body,
      );
      return response.comment;
    },

    /**
     * Delete a comment
     */
    delete: async (spaceId: string, documentId: string, commentId: string) => {
      await this.apiFetch<void>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/comments`,
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ commentId }),
        },
      );
    },
  };

  socket!: WebSocket;

  async connectToSocket(host: string, spaceId: string) {
    if (!this.socket) {
      this.socket = new WebSocket(
        `ws${!import.meta.env.DEV ? "s" : ""}://${host}/sync/${spaceId}`,
      );
      return new Promise<WebSocket>((resolve) => {
        this.socket.addEventListener("open", () => {
          resolve(this.socket);
        });
      });
    } else {
      return this.socket;
    }
  }
}
