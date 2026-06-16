import { applyUpdate, Doc as YDoc } from "yjs";
import {
  type PresenceJoinPayload,
  type PresenceLeaveMessage,
  type PresenceMessage,
  type PresenceSnapshotMessage,
  type PresenceUpdateMessage,
  type PresenceUpdatePayload,
  type PresenceUser,
  type RealtimeEventMessage,
  type RealtimeTopic,
  realtimeTopics,
  WsMsgType,
  wsDecode,
  wsDecodeJson,
  wsDecodeYjsUpdate,
  wsEncode,
  wsEncodeYjsUpdate,
} from "../utils/realtime.ts";

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

export interface JobSchedule {
  id: string;
  jobId: string;
  cronExpression: string;
  timezone: string | null;
  inputs: Record<string, unknown>;
  enabled: boolean;
  nextRunAt: Date | string | null;
  lastRunAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  createdBy: string;
}

export type JobRunTrigger = "cron" | "manual" | "workflow";

export type JobRunStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "timeout";

export interface JobRun {
  id: string;
  scheduleId: string | null;
  jobId: string;
  trigger: JobRunTrigger;
  status: JobRunStatus;
  error: string | null;
  queuedAt: Date | string;
  startedAt: Date | string | null;
  finishedAt: Date | string | null;
  initiatedBy: string | null;
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
  runId?: string;
  documentId?: string;
  status: WorkflowNodeStatus;
  createdAt?: string;
  sourceExtensionId?: string | null;
  runtimeInputs?: Record<string, unknown>;
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
  | "property_delete";

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
  spaceId: string;
  socket: WebSocket;
  /** Resolves when the current socket reaches the OPEN state. Never rejects. */
  ready: Promise<void>;
  topicRefCounts: Map<RealtimeTopic, number>;
  subscriptions: Set<RealtimeSubscription>;
  presenceRoomRefCounts: Map<string, number>;
  presenceSubscriptions: Set<PresenceSubscription<unknown>>;
  /** Active Yjs rooms keyed by documentId so they can be re-joined after a reconnect. */
  yjsRooms: Map<string, Set<YDoc>>;
  /** Latest presence join payload per room, replayed on reconnect (state kept current via updates). */
  presenceJoinPayloads: Map<string, PresenceJoinPayload<unknown>>;
  /** True once the connection has been intentionally torn down; suppresses reconnects. */
  closed: boolean;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

interface PresenceSubscription<TState = unknown> {
  room: string;
  callback: (event: PresenceMessage<TState>) => void;
}

/**
 * Main API client class with fluent interface
 * @example
 * const api = new ApiClient();
 * const users = await api.users.get("space-123");
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
     * List the members of a space (minimal profiles: id, name, image).
     */
    get: async (spaceId: string) => {
      return await this.apiGet<User[]>(
        this.baseUrl,
        `/api/v1/users?spaceId=${encodeURIComponent(spaceId)}`,
      );
    },
    /**
     * List candidate users to add to a space. Owner-only; includes email.
     */
    candidates: async (spaceId: string) => {
      return await this.apiGet<User[]>(
        this.baseUrl,
        `/api/v1/users?spaceId=${encodeURIComponent(spaceId)}&scope=candidates`,
      );
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
          permission: string;
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
     * List archived documents in a space
     */
    archived: async (spaceId: string, query?: { limit?: number; offset?: number }) => {
      const response = await this.apiGet<{
        documents: DocumentWithProperties[];
        total: number;
        limit: number;
        offset: number;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents/archived`, query);
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
        properties?: Record<string, unknown>;
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
    get: async (
      spaceId: string,
      documentId: string,
      query?: { rev?: number; draft?: boolean },
    ) => {
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
    get: async (
      spaceId: string,
      documentId: string,
      query?: { limit?: number; offset?: number },
    ) => {
      return this.apiGet<{
        auditLogs: AuditLog[];
        total: number;
        limit: number;
        offset: number;
      }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/audit-logs`,
        query,
      );
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
    get: async (spaceId: string, query?: { limit?: number; offset?: number }) => {
      return this.apiGet<{
        auditLogs: AuditLog[];
        total: number;
        limit: number;
        offset: number;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/audit-logs`, query);
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
        // Omitted for the space-wide "extensions" capability (no resource
        // target); required for viewer/editor resource grants.
        resourceType?: string;
        resourceId?: string;
        permission: string;
        expiresInDays?: number;
      },
    ) => {
      return await this.apiPost<{
        id: string;
        token: string;
        resources: unknown[];
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
      return await this.apiPut<{ resources: unknown[]; message: string }>(
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
      body?: { redirectTo?: string },
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
     * Update the reference (anchor) of one or more comments
     */
    patch: async (
      spaceId: string,
      documentId: string,
      body: {
        commentIds: string[];
        reference: string;
      },
    ) => {
      await this.apiPatch<{ success: boolean }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/comments`,
        body,
      );
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
        sourceExtensionId?: string;
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
          sourceExtensionId: options?.sourceExtensionId,
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
      await this.apiPost<{ ok: true }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/runs/${runId}`,
      );
    },

    listRuns: async (
      spaceId: string,
      query?: {
        sourceExtensionId?: string;
        filterDocumentId?: string;
        limit?: number;
        offset?: number;
      },
    ) => {
      const response = await this.apiGet<{
        runs: {
          runId: string;
          documentId: string;
          documentSlug: string | null;
          documentTitle: string;
          status: string;
          createdAt: string;
          startedAt: string | null;
          finishedAt: string | null;
          totalNodes: number;
          completedNodes: number;
          sourceExtensionId: string | null;
          runtimeInputs: Record<string, unknown>;
        }[];
        total: number;
        limit: number;
        offset: number;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/workflows/runs`, query);
      return response;
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

    /**
     * List job execution history (newest first)
     */
    listRuns: async (
      spaceId: string,
      options?: { jobId?: string; scheduleId?: string; limit?: number; offset?: number },
    ) => {
      return this.apiGet<{
        runs: JobRun[];
        total: number;
        limit: number;
        offset: number;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/jobs/runs`, options);
    },

    /**
     * List job schedules in a space
     */
    listSchedules: async (spaceId: string) => {
      return await this.apiGet<{ schedules: JobSchedule[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/jobs/schedules`,
      );
    },

    /**
     * Create a job schedule
     */
    createSchedule: async (
      spaceId: string,
      body: {
        jobId: string;
        cronExpression: string;
        timezone?: string;
        inputs?: Record<string, unknown>;
        enabled?: boolean;
      },
    ) => {
      return await this.apiPost<{ schedule: JobSchedule }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/jobs/schedules`,
        body,
      );
    },

    /**
     * Update a job schedule
     */
    updateSchedule: async (
      spaceId: string,
      scheduleId: string,
      body: {
        cronExpression?: string;
        timezone?: string | null;
        inputs?: Record<string, unknown> | null;
        enabled?: boolean;
      },
    ) => {
      return await this.apiPatch<{ schedule: JobSchedule }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/jobs/schedules/${scheduleId}`,
        body,
      );
    },

    /**
     * Delete a job schedule (run history is preserved)
     */
    deleteSchedule: async (spaceId: string, scheduleId: string) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/jobs/schedules/${scheduleId}`,
      );
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

    const connection: RealtimeConnection = {
      spaceId,
      // socket/ready are assigned synchronously by openRealtimeSocket below.
      socket: undefined as unknown as WebSocket,
      ready: Promise.resolve(),
      topicRefCounts: new Map(),
      subscriptions: new Set(),
      presenceRoomRefCounts: new Map(),
      presenceSubscriptions: new Set(),
      yjsRooms: new Map(),
      presenceJoinPayloads: new Map(),
      closed: false,
      reconnectAttempts: 0,
      reconnectTimer: null,
    };

    this.openRealtimeSocket(connection);
    this.realtimeConnections.set(spaceId, connection);
    return connection;
  }

  /**
   * Create (or recreate) the underlying WebSocket for a connection and wire up
   * its lifecycle handlers. Safe to call again after an unexpected close to
   * reconnect; existing subscription state is replayed in resyncRealtimeConnection.
   */
  private openRealtimeSocket(connection: RealtimeConnection): void {
    if (!this.socketHost) {
      throw new Error("provide a socketHost in options");
    }

    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${protocol}://${this.socketHost}/events/${connection.spaceId}`,
    );
    socket.binaryType = "arraybuffer";
    connection.socket = socket;
    connection.ready = new Promise<void>((resolve) => {
      socket.addEventListener("open", () => resolve(), { once: true });
    });

    socket.addEventListener("open", () => {
      if (connection.socket !== socket) return; // stale handler from a prior socket
      connection.reconnectAttempts = 0;
      this.resyncRealtimeConnection(connection);
    });

    socket.addEventListener("message", (event) => {
      if (connection.socket !== socket) return;
      this.handleRealtimeMessage(connection, event);
    });

    const onClose = () => {
      if (connection.socket !== socket) return; // a newer socket already took over
      this.handleRealtimeClose(connection);
    };
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
  }

  private handleRealtimeMessage(
    connection: RealtimeConnection,
    event: MessageEvent,
  ): void {
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

    if (type === WsMsgType.YjsUpdate) {
      const { documentId, update } = wsDecodeYjsUpdate(payload);
      const ydocs = connection.yjsRooms.get(documentId);
      if (ydocs) {
        for (const ydoc of ydocs) {
          applyUpdate(ydoc, update, "remote");
        }
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
        const targetRoom = msg.type === "presence-update" ? msg.presence.room : msg.room;
        if (targetRoom !== subscription.room) continue;
        subscription.callback(msg);
      }
    }
  }

  private handleRealtimeClose(connection: RealtimeConnection): void {
    if (connection.closed) return;

    // No active interest left — let it stay closed rather than reconnecting.
    if (
      connection.subscriptions.size === 0 &&
      connection.presenceSubscriptions.size === 0 &&
      connection.yjsRooms.size === 0
    ) {
      this.teardownRealtimeConnection(connection);
      return;
    }

    this.scheduleRealtimeReconnect(connection);
  }

  private scheduleRealtimeReconnect(connection: RealtimeConnection): void {
    if (connection.closed || connection.reconnectTimer !== null) return;

    // Exponential backoff capped at 30s, with jitter to avoid thundering herds.
    const attempt = connection.reconnectAttempts;
    const delay =
      Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 1_000);
    connection.reconnectAttempts = attempt + 1;

    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = null;
      if (connection.closed) return;
      this.openRealtimeSocket(connection);
    }, delay);
  }

  /**
   * Replay all active subscription state onto a freshly opened socket. Called on
   * every open (initial connect and reconnect) so it is the single source of
   * truth for what the server should know about — no per-call send is needed
   * while the socket is connecting.
   */
  private resyncRealtimeConnection(connection: RealtimeConnection): void {
    const socket = connection.socket;
    if (socket.readyState !== WebSocket.OPEN) return;

    const topics = [...connection.topicRefCounts.keys()];
    if (topics.length > 0) {
      socket.send(wsEncode(WsMsgType.Subscribe, { topics }));
    }

    for (const documentId of connection.yjsRooms.keys()) {
      socket.send(wsEncode(WsMsgType.YjsJoin, { documentId }));
    }

    for (const payload of connection.presenceJoinPayloads.values()) {
      socket.send(wsEncode(WsMsgType.PresenceJoin, payload));
    }
  }

  /** Permanently close a connection and stop any pending reconnect. */
  private teardownRealtimeConnection(connection: RealtimeConnection): void {
    connection.closed = true;
    if (connection.reconnectTimer !== null) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }
    if (this.realtimeConnections.get(connection.spaceId) === connection) {
      this.realtimeConnections.delete(connection.spaceId);
    }
    try {
      connection.socket.close();
    } catch {
      // ignore — socket may already be closing/closed
    }
  }

  /** Tear down the connection once nothing is subscribed to it anymore. */
  private maybeCloseRealtimeConnection(connection: RealtimeConnection): void {
    if (
      connection.subscriptions.size === 0 &&
      connection.presenceSubscriptions.size === 0 &&
      connection.yjsRooms.size === 0
    ) {
      this.teardownRealtimeConnection(connection);
    }
  }

  /**
   * Send subscription/state messages (subscribe, join, leave). Only sent when the
   * socket is open; while connecting or reconnecting the state is replayed by
   * resyncRealtimeConnection on the next open, so sending here would double up.
   */
  private sendRealtimeState(connection: RealtimeConnection, data: Uint8Array): void {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(data);
    }
  }

  /**
   * Send ephemeral messages (presence/yjs updates) that are not part of replayed
   * state. Best-effort: sent immediately when open, otherwise once the socket
   * opens. Guards against "WebSocket is already in CLOSING or CLOSED state".
   */
  private sendRealtimeEphemeral(connection: RealtimeConnection, data: Uint8Array): void {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(data);
      return;
    }
    void connection.ready.then(() => {
      if (connection.socket.readyState === WebSocket.OPEN) {
        connection.socket.send(data);
      }
    });
  }

  private sendRealtimeMessage(
    connection: RealtimeConnection,
    type: typeof WsMsgType.Subscribe | typeof WsMsgType.Unsubscribe,
    topics: RealtimeTopic[],
  ) {
    if (topics.length === 0) return;
    this.sendRealtimeState(connection, wsEncode(type, { topics }));
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

      this.maybeCloseRealtimeConnection(connection);
    };
  }

  subscribeToDocument(
    spaceId: string,
    documentId: string,
    callback: (event: RealtimeEventMessage) => void,
  ): () => void {
    return this.subscribeToTopics(
      spaceId,
      [realtimeTopics.document(documentId)],
      callback,
    );
  }

  subscribeToDocumentTree(
    spaceId: string,
    callback: (event: RealtimeEventMessage) => void,
  ): () => void {
    return this.subscribeToTopics(spaceId, [realtimeTopics.documentTree], callback);
  }

  /** Fires whenever any workflow run in the space changes (created/progress/terminal). */
  subscribeToWorkflowRuns(
    spaceId: string,
    callback: (event: RealtimeEventMessage) => void,
  ): () => void {
    return this.subscribeToTopics(spaceId, [realtimeTopics.workflowRuns], callback);
  }

  joinYjsRoom(spaceId: string, documentId: string, ydoc: YDoc): () => void {
    if (!(ydoc instanceof YDoc)) {
      console.warn("Ignoring Yjs room join without a Y.Doc", { documentId, spaceId });
      return () => {};
    }

    const connection = this.getRealtimeConnection(spaceId);

    let ydocs = connection.yjsRooms.get(documentId);
    if (!ydocs) {
      ydocs = new Set();
      connection.yjsRooms.set(documentId, ydocs);
      // First doc for this room — announce the join (replayed on reconnect).
      this.sendRealtimeState(connection, wsEncode(WsMsgType.YjsJoin, { documentId }));
    }
    ydocs.add(ydoc);

    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      this.sendRealtimeEphemeral(connection, wsEncodeYjsUpdate(documentId, update));
    };

    ydoc.on("update", handleUpdate);

    return () => {
      ydoc.off("update", handleUpdate);
      const rooms = connection.yjsRooms.get(documentId);
      if (rooms) {
        rooms.delete(ydoc);
        if (rooms.size === 0) {
          connection.yjsRooms.delete(documentId);
        }
      }
      this.maybeCloseRealtimeConnection(connection);
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
      const joinPayload: PresenceJoinPayload<TState> = {
        room,
        clientId,
        user,
        state: initialState,
      };
      // Remember the join so it can be replayed after a reconnect; its `state`
      // is kept current by `update` below.
      connection.presenceJoinPayloads.set(
        room,
        joinPayload as PresenceJoinPayload<unknown>,
      );
      this.sendRealtimeState(connection, wsEncode(WsMsgType.PresenceJoin, joinPayload));
    }

    const update = (state: TState) => {
      const stored = connection.presenceJoinPayloads.get(room);
      if (stored) {
        stored.state = state;
      }
      const updatePayload: PresenceUpdatePayload<TState> = {
        room,
        clientId,
        state,
      };
      this.sendRealtimeEphemeral(
        connection,
        wsEncode(WsMsgType.PresenceUpdate, updatePayload),
      );
    };

    const leave = () => {
      connection.presenceSubscriptions.delete(subscription);

      const currentCount = connection.presenceRoomRefCounts.get(room) ?? 0;
      if (currentCount <= 1) {
        connection.presenceRoomRefCounts.delete(room);
        connection.presenceJoinPayloads.delete(room);
        this.sendRealtimeState(
          connection,
          wsEncode(WsMsgType.PresenceLeave, { room, clientId }),
        );
      } else {
        connection.presenceRoomRefCounts.set(room, currentCount - 1);
      }

      this.maybeCloseRealtimeConnection(connection);
    };

    return { update, leave };
  }
}
