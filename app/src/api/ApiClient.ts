import {
  type PresenceJoinPayload,
  type PresenceLeaveMessage,
  type PresenceMessage,
  type PresenceSnapshotMessage,
  type PresenceUpdateMessage,
  type PresenceUpdatePayload,
  type PresenceUser,
  realtimeTopics,
  WsMsgType,
  wsEncode,
  wsEncodeYjsUpdate,
  wsDecode,
  wsDecodeJson,
  wsDecodeYjsUpdate,
  type RealtimeEventMessage,
  type RealtimeTopic,
} from "../utils/realtime.ts";
import { applyUpdate, type Doc as YDoc } from "yjs";

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
  status: "open" | "applied" | "dismissed" | null;
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
  status: "open" | "applied" | "dismissed" | null;
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

export type WorkflowNodeStatus = "pending" | "running" | "completed" | "failed";

export interface WorkflowNodeState {
  status: WorkflowNodeStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown> | null;
  error: string | null;
  logs: string[];
  startedAt: string | null;
  completedAt: string | null;
}

export interface WorkflowRunStatus {
  status: WorkflowNodeStatus;
  nodes: Record<string, WorkflowNodeState>;
  output: Record<string, unknown> | null;
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

export interface ExtensionJobField {
  type: string;
  required?: boolean;
}

export interface ExtensionJobInfo {
  id: string;
  name: string;
  inputs?: Record<string, ExtensionJobField>;
  outputs?: Record<string, ExtensionJobField>;
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
  jobs?: ExtensionJobInfo[];
  createdAt: Date | string;
  updatedAt: Date | string;
  createdBy: string;
}

export interface ExtensionManifestError {
  id: string;
  error: string;
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

export interface SpaceSecret {
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  lastUsedAt: Date | string | null;
}

export type OAuthIntegrationProvider = "gitlab" | "youtrack";

export interface OAuthIntegrationConnection {
  provider: OAuthIntegrationProvider;
  label: string;
  configured: boolean;
  missingConfig: string[];
  connected: boolean;
  externalAccountId: string | null;
  externalUsername: string | null;
  instanceUrl: string | null;
  scopes: string[];
  accessTokenExpiresAt: Date | string | null;
  createdAt: Date | string | null;
  updatedAt: Date | string | null;
  lastUsedAt: Date | string | null;
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

export type DocumentPropertyPatchValue =
  | string
  | number
  | boolean
  | null
  | { value: string | number | boolean | null; type?: string | null };

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

interface RealtimeSubscription {
  topics: Set<RealtimeTopic>;
  callback: (event: RealtimeEventMessage) => void;
}

interface RealtimeConnection {
  socket: WebSocket;
  ready: Promise<void>;
  topicRefCounts: Map<RealtimeTopic, number>;
  subscriptions: Set<RealtimeSubscription>;
  presenceRoomRefCounts: Map<string, number>;
  presenceSubscriptions: Set<PresenceSubscription<any>>;
}

interface PresenceSubscription<TState = unknown> {
  room: string;
  callback: (event: PresenceMessage<TState>) => void;
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
  realtimeConnections = new Map<string, RealtimeConnection>();

  constructor(options: {
    baseUrl?: string;
    accessToken?: string;
    socketHost?: string;
  }) {
    this.baseUrl = options.baseUrl ?? "";
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
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      },
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
      return await this.apiGet<User>(
        this.baseUrl,
        `/api/v1/users?id=${encodeURIComponent(id)}`,
      );
    },
    /**
     * Get the currently authenticated user
     */
    me: async () => {
      return await this.apiGet<User>(this.baseUrl, "/api/v1/users/me");
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
      const response = await this.apiPost<{ space: Space }>(
        this.baseUrl,
        "/api/v1/spaces",
        body,
      );
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
     * Partially update a space (PATCH)
     */
    patch: async (
      spaceId: string,
      body: { name?: string; slug?: string; preferences?: Record<string, string> },
    ) => {
      return await this.apiPatch<Space>(this.baseUrl, `/api/v1/spaces/${spaceId}`, body);
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
      return await this.apiGet<SpaceMember[]>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/members`,
      );
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
    list: async (
      spaceId: string,
      type?: "role" | "feature" | "all",
      options?: {
        resourceType?: string;
        resourceId?: string;
      },
    ) => {
      const query = new URLSearchParams();
      if (type && type !== "all") query.set("type", type);
      if (options?.resourceType) query.set("resourceType", options.resourceType);
      if (options?.resourceId) query.set("resourceId", options.resourceId);
      const queryString = query.toString();
      const url = `/api/v1/spaces/${spaceId}/permissions${queryString ? `?${queryString}` : ""}`;
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
        resourceType?: string;
        resourceId?: string;
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
        resourceType?: string;
        resourceId?: string;
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
    get: async (
      spaceId: string,
      query?: Record<string, string | number | boolean | undefined>,
    ) => {
      const response = await this.apiGet<{
        documents: DocumentWithProperties[];
        total: number;
        limit: number;
        offset: number;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents`, query);
      return response;
    },

    /**
     * List documents by categories as a grouped map, including descendants.
     */
    getByCategories: async (spaceId: string, categorySlugs: string[]) => {
      const response = await this.apiGet<{
        documentsByCategory: Record<string, DocumentWithProperties[]>;
        categorySlugs: string[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents`, {
        categorySlugs: categorySlugs.join(","),
        grouped: true,
      });
      return response.documentsByCategory;
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
        body: content,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`API request failed: ${response.status} ${error}`);
      }

      const data = (await response.json()) as { document: DocumentWithProperties };
      return data.document;
    },

    /**
     * Patch document metadata and operations
     */
    patch: async (
      spaceId: string,
      documentId: string,
      body: {
        properties?: Record<string, DocumentPropertyPatchValue>;
        parentId?: string | null;
        publishedRev?: number | null;
        readonly?: boolean;
      },
    ) => {
      return await this.apiPatch<{ success?: boolean; slug?: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}`,
        body,
      );
    },

    /**
     * Archive a document
     */
    archive: async (spaceId: string, documentId: string) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}`,
      );
    },

    /**
     * Delete a document permanently
     */
    delete: async (spaceId: string, documentId: string) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}?permanent=true`,
      );
    },

    /**
     * Restore an archived document
     */
    restore: async (spaceId: string, documentId: string) => {
      return await this.apiPut<{ success: boolean }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}`,
        { restore: true },
      );
    },

    /**
     * Save a revision (POST to document endpoint)
     */
    post: async (
      spaceId: string,
      documentId: string,
      body: { html: string; message?: string; mode?: "revision" | "suggestion" },
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

  documentPublish = {
    /**
     * Restore a document to a specific revision
     */
    post: async (spaceId: string, documentId: string, rev: number) => {
      await this.apiPost(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/revisions?rev=${rev}`,
        {},
      );
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
      const result = await this.apiGet<{
        files: { key: string; url: string; size: number; updatedAt: string }[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/uploads`);
      return result.files;
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
     * Grant token access to a specific resource
     */
    grantResource: async (
      spaceId: string,
      tokenId: string,
      resourceType: string,
      resourceId: string,
      body: { permission: string },
    ) => {
      return await this.apiPut<{ resources: any[]; message: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens/${tokenId}/resources/${resourceType}/${resourceId}`,
        body,
      );
    },

    /**
     * Revoke token access to a specific resource
     */
    revokeResource: async (
      spaceId: string,
      tokenId: string,
      resourceType: string,
      resourceId: string,
    ) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens/${tokenId}/resources/${resourceType}/${resourceId}`,
      );
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
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens/${tokenId}`,
      );
    },
  };

  secrets = {
    /**
     * List secrets in a space (owner only)
     */
    get: async (spaceId: string) => {
      return await this.apiGet<{ secrets: SpaceSecret[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/secrets`,
      );
    },

    /**
     * Read one secret value by name
     */
    getByName: async (spaceId: string, name: string) => {
      return await this.apiGet<{ name: string; value: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/secrets/${encodeURIComponent(name)}`,
      );
    },

    /**
     * Create or upsert a secret by name
     */
    create: async (
      spaceId: string,
      body: { name: string; value: string; description?: string | null },
    ) => {
      return await this.apiPost<{ secret: SpaceSecret }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/secrets`,
        body,
      );
    },

    /**
     * Rotate/update secret value by name
     */
    update: async (
      spaceId: string,
      name: string,
      body: { value: string; description?: string | null },
    ) => {
      return await this.apiPut<{ secret: SpaceSecret }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/secrets/${encodeURIComponent(name)}`,
        body,
      );
    },

    /**
     * Delete secret by name
     */
    delete: async (spaceId: string, name: string) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/secrets/${encodeURIComponent(name)}`,
      );
    },
  };

  integrations = {
    /**
     * List OAuth integrations for current user in a space
     */
    get: async (spaceId: string) => {
      return await this.apiGet<{ connections: OAuthIntegrationConnection[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/integrations`,
      );
    },

    /**
     * Get one provider integration status
     */
    getByProvider: async (spaceId: string, provider: OAuthIntegrationProvider) => {
      return await this.apiGet<{ connection: OAuthIntegrationConnection }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/integrations/${provider}`,
      );
    },

    /**
     * Start OAuth connect flow for provider
     */
    connect: async (
      spaceId: string,
      provider: OAuthIntegrationProvider,
      body?: { redirectTo?: string; instanceUrl?: string },
    ) => {
      return await this.apiPost<{ authorizeUrl: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/integrations/${provider}/connect`,
        body ?? {},
      );
    },

    /**
     * Disconnect provider
     */
    disconnect: async (spaceId: string, provider: OAuthIntegrationProvider) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/integrations/${provider}`,
      );
    },
  };

  webhooks = {
    /**
     * List webhooks in a space
     */
    get: async (spaceId: string) => {
      return await this.apiGet<{ webhooks: Webhook[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/webhooks`,
      );
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
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/webhooks/${webhookId}`,
      );
    },
  };

  extensions = {
    /**
     * List all extensions in a space
     */
    get: async (
      spaceId: string,
    ): Promise<{ extensions: ExtensionInfo[]; errors: ExtensionManifestError[] }> => {
      const response = await this.apiGet<{
        extensions: ExtensionInfo[];
        errors?: ExtensionManifestError[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/extensions`);

      return {
        extensions: response.extensions ?? [],
        errors: response.errors ?? [],
      };
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
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/extensions/${extensionId}`,
      );
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

  workflows = {
    /**
     * Start a workflow run for a workflow document
     */
    startRun: async (
      spaceId: string,
      documentId: string,
      inputs?: Record<string, unknown>,
      options?: {
        fromRunId?: string;
        fromNodeId?: string;
      },
    ): Promise<{ runId: string }> => {
      return await this.apiPost<{ runId: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/runs`,
        {
          documentId,
          inputs,
          fromRunId: options?.fromRunId,
          fromNodeId: options?.fromNodeId,
        },
      );
    },

    /**
     * Get the latest run status for a workflow document. Returns null if no run exists.
     */
    getLatestRun: async (
      spaceId: string,
      documentId: string,
    ): Promise<{ runId: string; status: string } | null> => {
      try {
        return await this.apiGet<{ runId: string; status: string }>(
          this.baseUrl,
          `/api/v1/spaces/${spaceId}/workflows/runs?documentId=${encodeURIComponent(documentId)}`,
        );
      } catch {
        return null;
      }
    },

    /**
     * Get the status of a workflow run
     */
    getRun: async (spaceId: string, runId: string): Promise<WorkflowRunStatus> => {
      return await this.apiGet<WorkflowRunStatus>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/runs/${runId}`,
      );
    },

    cancelRun: async (spaceId: string, runId: string): Promise<void> => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/runs/${runId}`,
      );
    },

    listRuns: async (spaceId: string) => {
      const response = await this.apiGet<{
        runs: {
          runId: string;
          documentId: string;
          documentSlug: string | null;
          documentTitle: string;
          status: string;
        }[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/workflows/runs`);
      return response.runs;
    },

    /** @deprecated use listRuns */
    listRunning: async (spaceId: string) => {
      const response = await this.apiGet<{
        runs: {
          runId: string;
          documentId: string;
          documentSlug: string | null;
          documentTitle: string;
          status: string;
        }[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/workflows/runs`);
      return response.runs;
    },
  };

  jobs = {
    run: async (
      spaceId: string,
      jobId: string,
      inputs: Record<string, unknown> = {},
    ): Promise<{ outputs: Record<string, unknown>; logs: string[] }> => {
      return await this.apiPost(this.baseUrl, `/api/v1/spaces/${spaceId}/jobs/run`, {
        jobId,
        inputs,
      });
    },

    runStream: (
      spaceId: string,
      jobId: string,
      inputs: Record<string, unknown> = {},
      signal?: AbortSignal,
    ): Promise<Response> => {
      return fetch(`${this.baseUrl}/api/v1/spaces/${spaceId}/jobs/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ jobId, inputs, stream: true }),
        signal,
      });
    },
  };

  private getRealtimeConnection(spaceId: string): RealtimeConnection {
    const existingConnection = this.realtimeConnections.get(spaceId);
    if (existingConnection) {
      return existingConnection;
    }

    if (!this.socketHost) {
      throw new Error("provide a socketHost in options");
    }

    const socket = new WebSocket(
      `ws${!import.meta.env.DEV ? "s" : ""}://${this.socketHost}/events/${spaceId}`,
    );
    socket.binaryType = "arraybuffer";

    const connection: RealtimeConnection = {
      socket,
      ready: new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("Realtime socket failed")), {
          once: true,
        });
      }),
      topicRefCounts: new Map(),
      subscriptions: new Set(),
      presenceRoomRefCounts: new Map(),
      presenceSubscriptions: new Set(),
    };

    socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const { type, payload } = wsDecode(new Uint8Array(event.data));

      if (type === WsMsgType.Event) {
        const msg = wsDecodeJson<Omit<RealtimeEventMessage, "type">>(payload);
        for (const subscription of connection.subscriptions) {
          if (!msg.events.some(({ topic }) => subscription.topics.has(topic))) continue;
          subscription.callback({ type: "event", ...msg });
        }
        return;
      }

      if (
        type === WsMsgType.PresenceSnapshot ||
        type === WsMsgType.PresenceUpdate ||
        type === WsMsgType.PresenceLeave
      ) {
        const msg =
          type === WsMsgType.PresenceSnapshot
            ? ({
                type: "presence-snapshot",
                ...wsDecodeJson<Omit<PresenceSnapshotMessage, "type">>(payload),
              } satisfies PresenceSnapshotMessage)
            : type === WsMsgType.PresenceUpdate
              ? ({
                  type: "presence-update",
                  ...wsDecodeJson<Omit<PresenceUpdateMessage, "type">>(payload),
                } satisfies PresenceUpdateMessage)
              : ({
                  type: "presence-leave",
                  ...wsDecodeJson<Omit<PresenceLeaveMessage, "type">>(payload),
                } satisfies PresenceLeaveMessage);

        for (const subscription of connection.presenceSubscriptions) {
          const targetRoom =
            msg.type === "presence-update" ? msg.presence.room : msg.room;
          if (targetRoom !== subscription.room) continue;
          subscription.callback(msg);
        }
      }
    });

    const destroyConnection = () => {
      if (this.realtimeConnections.get(spaceId) === connection) {
        this.realtimeConnections.delete(spaceId);
      }
    };

    socket.addEventListener("close", destroyConnection, { once: true });
    socket.addEventListener("error", destroyConnection);

    this.realtimeConnections.set(spaceId, connection);
    return connection;
  }

  private sendRealtimeMessage(
    connection: RealtimeConnection,
    type: typeof WsMsgType.Subscribe | typeof WsMsgType.Unsubscribe,
    topics: RealtimeTopic[],
  ) {
    if (topics.length === 0) return;

    void connection.ready.then(() => {
      connection.socket.send(wsEncode(type, { topics }));
    }).catch(() => {});
  }

  subscribeToTopics(
    spaceId: string,
    topics: RealtimeTopic[],
    callback: (event: RealtimeEventMessage) => void,
  ): () => void {
    const normalizedTopics = [...new Set(topics.filter(Boolean))];
    const connection = this.getRealtimeConnection(spaceId);
    const subscription: RealtimeSubscription = {
      topics: new Set(normalizedTopics),
      callback,
    };

    connection.subscriptions.add(subscription);

    const subscribeTopics: RealtimeTopic[] = [];
    for (const topic of normalizedTopics) {
      const nextCount = (connection.topicRefCounts.get(topic) ?? 0) + 1;
      connection.topicRefCounts.set(topic, nextCount);
      if (nextCount === 1) {
        subscribeTopics.push(topic);
      }
    }
    this.sendRealtimeMessage(connection, WsMsgType.Subscribe, subscribeTopics);

    return () => {
      connection.subscriptions.delete(subscription);

      const unsubscribeTopics: RealtimeTopic[] = [];
      for (const topic of normalizedTopics) {
        const currentCount = connection.topicRefCounts.get(topic);
        if (!currentCount) {
          continue;
        }

        if (currentCount === 1) {
          connection.topicRefCounts.delete(topic);
          unsubscribeTopics.push(topic);
          continue;
        }

        connection.topicRefCounts.set(topic, currentCount - 1);
      }

      this.sendRealtimeMessage(connection, WsMsgType.Unsubscribe, unsubscribeTopics);

      if (
        connection.subscriptions.size === 0 &&
        connection.presenceSubscriptions.size === 0
      ) {
        connection.socket.close();
        this.realtimeConnections.delete(spaceId);
      }
    };
  }

  subscribeToDocument(
    spaceId: string,
    documentId: string,
    callback: (event: RealtimeEventMessage) => void,
  ): () => void {
    return this.subscribeToTopics(spaceId, [realtimeTopics.document(documentId)], callback);
  }

  subscribeToDocumentTree(
    spaceId: string,
    callback: (event: RealtimeEventMessage) => void,
  ): () => void {
    return this.subscribeToTopics(spaceId, [realtimeTopics.documentTree], callback);
  }

  joinYjsRoom(
    spaceId: string,
    documentId: string,
    ydoc: YDoc,
  ): () => void {
    const connection = this.getRealtimeConnection(spaceId);
    connection.socket.binaryType = "arraybuffer";

    void connection.ready.then(() => {
      connection.socket.send(wsEncode(WsMsgType.YjsJoin, { documentId }));
    }).catch(() => {});

    const handleMessage = (event: MessageEvent) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      const { type, payload } = wsDecode(new Uint8Array(event.data));
      if (type !== WsMsgType.YjsUpdate) return;

      const { documentId: incomingDocId, update } = wsDecodeYjsUpdate(payload);
      if (incomingDocId !== documentId) return;

      applyUpdate(ydoc, update, "remote");
    };

    connection.socket.addEventListener("message", handleMessage);

    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;

      void connection.ready.then(() => {
        connection.socket.send(wsEncodeYjsUpdate(documentId, update));
      }).catch(() => {});
    };

    ydoc.on("update", handleUpdate);

    return () => {
      ydoc.off("update", handleUpdate);
      connection.socket.removeEventListener("message", handleMessage);
    };
  }

  joinPresenceRoom<TState>(
    spaceId: string,
    room: string,
    clientId: string,
    user: PresenceUser,
    callback: (event: PresenceMessage<TState>) => void,
    initialState?: TState,
  ): { update: (state: TState) => void; leave: () => void } {
    const connection = this.getRealtimeConnection(spaceId);
    const subscription: PresenceSubscription<TState> = {
      room,
      callback,
    };
    connection.presenceSubscriptions.add(subscription);

    const roomRefCount = (connection.presenceRoomRefCounts.get(room) ?? 0) + 1;
    connection.presenceRoomRefCounts.set(room, roomRefCount);

    if (roomRefCount === 1) {
      void connection.ready.then(() => {
        const joinPayload: PresenceJoinPayload<TState> = {
          room,
          clientId,
          user,
          state: initialState,
        };
        connection.socket.send(wsEncode(WsMsgType.PresenceJoin, joinPayload));
      }).catch(() => {});
    }

    const update = (state: TState) => {
      const updatePayload: PresenceUpdatePayload<TState> = {
        room,
        clientId,
        state,
      };
      void connection.ready.then(() => {
        connection.socket.send(wsEncode(WsMsgType.PresenceUpdate, updatePayload));
      }).catch(() => {});
    };

    const leave = () => {
      connection.presenceSubscriptions.delete(subscription);

      const currentCount = connection.presenceRoomRefCounts.get(room) ?? 0;
      if (currentCount <= 1) {
        connection.presenceRoomRefCounts.delete(room);
        void connection.ready.then(() => {
          connection.socket.send(wsEncode(WsMsgType.PresenceLeave, {
            room,
            clientId,
          }));
        }).catch(() => {});
      } else {
        connection.presenceRoomRefCounts.set(room, currentCount - 1);
      }

      if (
        connection.subscriptions.size === 0 &&
        connection.presenceSubscriptions.size === 0
      ) {
        connection.socket.close();
        this.realtimeConnections.delete(spaceId);
      }
    };

    return { update, leave };
  }
}
