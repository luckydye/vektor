import { applyUpdate, encodeStateAsUpdate, Doc as YDoc } from "yjs";
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
} from "#utils/realtime.ts";
import { ApiReplica, type OptimisticReplicaOperation } from "./ApiReplica.ts";

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
  fileUrl?: string;
}

export interface DocumentWithProperties extends Document {
  properties: Record<string, string | string[]>;
  mentionCount?: number;
  /** Natural width/height ratio derived from the stored header image. */
  headerImageAspectRatio?: number | null;
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

export type RevisionSuggestionStatus = "open" | "applied" | "dismissed";

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

export interface WorkflowSchedule {
  id: string;
  documentId: string;
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

export type WorkflowRunState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkflowArtifact {
  key: string;
  url: string;
}

export interface WorkflowRunStatus {
  runId?: string;
  documentId?: string;
  status: WorkflowRunState;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
  sourceExtensionId?: string | null;
  runtimeInputs?: Record<string, unknown>;
  error: string | null;
  logs: string[];
  /** The script return value, serialized as a JSON artifact. */
  resultArtifact: WorkflowArtifact | null;
  /** Completed logs, serialized as a JSON artifact. */
  logArtifact: WorkflowArtifact | null;
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
  /** Where this view should be placed. Can include "page" (default), home placements, or "document" for inline document embedding */
  placements?: Array<"page" | "home-top" | "document">;
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

export type ExtensionSource = "upload" | "marketplace" | "system";

export interface ExtensionInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  source: ExtensionSource;
  sourceRef: string | null;
  sourcePublisher: string | null;
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

type PermissionResourceType =
  | "space"
  | "document"
  | "document_tree"
  | "category"
  | "extension"
  | "secret"
  | "feature";

export interface SpaceSecret {
  name: string;
  description: string | null;
  createdBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  lastUsedAt: Date | string | null;
}

export type AIConfigMeta =
  | { configured: false }
  | {
      configured: true;
      provider: string;
      model: string;
      baseUrl?: string;
      hasApiKey: boolean;
    };

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
  | "comment"
  | "save"
  | "suggest"
  | "publish"
  | "unpublish"
  | "restore"
  | "archive"
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
  commentId?: string;
  parentId?: string | null;
  reference?: string | null;
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
  | string[]
  | number
  | boolean
  | null
  | { value: string | string[] | number | boolean | null; type?: string | null };

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
  properties: Record<string, string | string[]>;
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
    image: string | null;
  } | null;
}

export interface AIChatMessage {
  role: "user" | "assistant" | "system" | "tool" | "status" | "thinking";
  content: string;
  timestamp: number;
  toolName?: string;
  toolCallId?: string;
  toolPhase?: "call" | "result";
  isError?: boolean;
  attachments?: Array<{
    key: string;
    url: string;
    name: string;
    type: string;
    size: number;
    isImage: boolean;
  }>;
}

export interface AIChatSession {
  id: string;
  title: string;
  spaceId: string;
  createdAt: number;
  updatedAt: number;
  messages: AIChatMessage[];
  conversationHistory: Array<{
    role: "system" | "user" | "assistant" | "tool";
    content?: string | null;
    thinking?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
    tool_call_id?: string;
  }>;
  shellSnapshot?: string | null;
}

interface RealtimeSubscription {
  topics: Set<RealtimeTopic>;
  callback: (event: RealtimeEventMessage) => void;
}

interface YjsRoomEntry {
  ydoc: YDoc;
  onSynced?: () => void;
}

interface RealtimeConnection {
  spaceId: string;
  socket: WebSocket;
  /** Resolves when the current socket reaches the OPEN state. Never rejects. */
  ready: Promise<void>;
  topicRefCounts: Map<RealtimeTopic, number>;
  subscriptions: Set<RealtimeSubscription>;
  presenceSubscriptions: Set<PresenceSubscription<unknown>>;
  /** Active Yjs rooms keyed by documentId so they can be re-joined after a reconnect. */
  yjsRooms: Map<string, Set<YjsRoomEntry>>;
  /** Latest presence join payload per room/client, replayed on reconnect (state kept current via updates). */
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

type ReplicaRollback = () => Promise<void>;

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
  private readonly responseReplica = new ApiReplica();
  private replicaScope: string | null = null;

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
   * Enable the persistent response replica for the current browser identity.
   * A scope is intentionally required: browser sessions can change users while
   * IndexedDB survives logout, so unscoped API data is never persisted.
   */
  setReplicaScope(scope: string | null | undefined): void {
    this.replicaScope = scope?.trim() || null;
  }

  private buildUrl(
    base: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    let finalUrl = `${base}${path}`;
    if (!query) return finalUrl;

    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) {
        searchParams.append(key, String(value));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      finalUrl = `${base}${path}${path.includes("?") ? "&" : "?"}${queryString}`;
    }
    return finalUrl;
  }

  private scopedReplicaKey(key: string): string | null {
    if (!this.replicaScope) return null;

    const origin =
      typeof window === "undefined" ? this.baseUrl || "server" : window.location.origin;
    return `v1:${origin}:${this.replicaScope}:${key}`;
  }

  private replicaKey(finalUrl: string): string | null {
    let normalizedUrl = finalUrl;
    try {
      const origin =
        typeof window === "undefined" ? this.baseUrl || "server" : window.location.origin;
      normalizedUrl = new URL(finalUrl, origin).toString();
    } catch {
      // Retain the request string if a custom base/path is not URL parseable.
    }
    return this.scopedReplicaKey(`response:${normalizedUrl}`);
  }

  private documentReplicaKey(spaceId: string, documentId: string): string | null {
    return this.scopedReplicaKey(`document:${spaceId}:${documentId}`);
  }

  private documentAliasKey(spaceId: string, slug: string): string | null {
    return this.scopedReplicaKey(`document-alias:${spaceId}:${slug}`);
  }

  private documentsPath(spaceId: string): string {
    return `/api/v1/spaces/${spaceId}/documents`;
  }

  private documentCommentsPath(spaceId: string, documentId: string): string {
    return `/api/v1/spaces/${spaceId}/documents/${documentId}/comments`;
  }

  private categorySlugsQuery(categorySlugs: string[]): string {
    return [...new Set(categorySlugs)].sort().join(",");
  }

  private isDocumentDetailPath(path: string): boolean {
    return /^\/api\/v1\/spaces\/[^/]+\/documents\/[^/?]+$/.test(path);
  }

  private isReplicatedRead(method: string, path: string): boolean {
    if (
      method !== "GET" ||
      !path.startsWith("/api/v1/") ||
      this.isDocumentDetailPath(path)
    ) {
      return false;
    }

    // Replicate durable application state only. Security-sensitive responses,
    // large/binary resources, and transient supporting views are deliberately
    // network-only.
    return ![
      "/access-tokens",
      "/secrets",
      "/ai-chat",
      "/uploads",
      "/url-metadata",
      "/package",
      "/breadcrumbs",
      "/audit-logs",
      "/contributors",
      "/members",
      "/permissions",
      "/users",
    ].some((segment) => path.includes(segment));
  }

  /** Read a previously replicated JSON response without issuing a request. */
  async readReplica<T>(
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T | undefined> {
    const key = this.replicaKey(this.buildUrl(this.baseUrl, path, query));
    if (!key) return undefined;
    return (await this.responseReplica.get<T>(key))?.value;
  }

  /**
   * Observe a replicated response. The callback only fires for changes after
   * subscription; callers should hydrate with readReplica first.
   */
  subscribeToReplica<T>(
    path: string,
    callback: (value: T | undefined) => void,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): () => void {
    const key = this.replicaKey(this.buildUrl(this.baseUrl, path, query));
    if (!key) return () => {};
    return this.responseReplica.subscribe<T>(key, (entry) => callback(entry?.value));
  }

  /** Resolve a document id or slug through the canonical document replica. */
  async readDocumentReplica(
    spaceId: string,
    documentIdOrSlug: string,
  ): Promise<DocumentWithProperties | undefined> {
    const directKey = this.documentReplicaKey(spaceId, documentIdOrSlug);
    if (directKey) {
      const direct = await this.responseReplica.get<{ document: DocumentWithProperties }>(
        directKey,
      );
      if (direct) return direct.value.document;
    }

    const aliasKey = this.documentAliasKey(spaceId, documentIdOrSlug);
    if (!aliasKey) return undefined;
    const alias = await this.responseReplica.get<{ documentId: string }>(aliasKey);
    if (!alias) return undefined;

    const documentKey = this.documentReplicaKey(spaceId, alias.value.documentId);
    if (!documentKey) return undefined;
    return (
      await this.responseReplica.get<{ document: DocumentWithProperties }>(documentKey)
    )?.value.document;
  }

  /**
   * Subscribe to the canonical document entry. A slug subscription first
   * watches its small alias record, then follows it to the document id.
   */
  subscribeToDocumentReplica(
    spaceId: string,
    documentIdOrSlug: string,
    callback: (document: DocumentWithProperties | undefined) => void,
  ): () => void {
    const directKey = this.documentReplicaKey(spaceId, documentIdOrSlug);
    const aliasKey = this.documentAliasKey(spaceId, documentIdOrSlug);
    if (!directKey || !aliasKey) return () => {};

    let currentDocumentKey: string | null = null;
    let unsubscribeDocument = () => {};
    let disposed = false;

    const attachDocument = (documentId: string) => {
      const documentKey = this.documentReplicaKey(spaceId, documentId);
      if (!documentKey || currentDocumentKey === documentKey || disposed) return;

      unsubscribeDocument();
      currentDocumentKey = documentKey;
      unsubscribeDocument = this.responseReplica.subscribe<{
        document: DocumentWithProperties;
      }>(documentKey, (entry) => callback(entry?.value.document));
      void this.responseReplica
        .get<{ document: DocumentWithProperties }>(documentKey)
        .then((entry) => {
          if (!disposed && currentDocumentKey === documentKey) {
            callback(entry?.value.document);
          }
        });
    };

    attachDocument(documentIdOrSlug);
    const unsubscribeAlias = this.responseReplica.subscribe<{ documentId: string }>(
      aliasKey,
      (entry) => {
        if (entry?.value.documentId) attachDocument(entry.value.documentId);
      },
    );
    void this.responseReplica.get<{ documentId: string }>(aliasKey).then((entry) => {
      if (entry?.value.documentId) attachDocument(entry.value.documentId);
    });

    return () => {
      disposed = true;
      unsubscribeDocument();
      unsubscribeAlias();
    };
  }

  private async replaceReplica<T>(
    path: string,
    value: T,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<void> {
    const key = this.replicaKey(this.buildUrl(this.baseUrl, path, query));
    if (!key) return;
    await this.responseReplica.replaceRemote(key, value);
  }

  private async applyOptimisticReplica<T>(
    path: string,
    updater: (current: T | undefined) => T | undefined,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<OptimisticReplicaOperation<T> | null> {
    const key = this.replicaKey(this.buildUrl(this.baseUrl, path, query));
    if (!key) return null;
    return await this.responseReplica.applyOptimistic(key, updater);
  }

  private async rollbackOptimisticReplica<T>(
    operation: OptimisticReplicaOperation<T> | null,
  ): Promise<void> {
    if (!operation) return;
    await this.responseReplica.rollback(operation);
  }

  private async optimisticReplica<T>(
    path: string,
    updater: (current: T | undefined) => T | undefined,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<ReplicaRollback> {
    const operation = await this.applyOptimisticReplica(path, updater, query);
    return async () => await this.rollbackOptimisticReplica(operation);
  }

  private async withOptimisticReplica<TResult>(
    optimistic: () => Promise<ReplicaRollback | ReplicaRollback[]>,
    request: () => Promise<TResult>,
    reconcile?: (result: TResult) => Promise<void>,
  ): Promise<TResult> {
    const pendingRollbacks = await optimistic();
    const rollbacks = Array.isArray(pendingRollbacks)
      ? pendingRollbacks
      : [pendingRollbacks];

    try {
      const result = await request();
      await reconcile?.(result);
      return result;
    } catch (error) {
      await Promise.all(rollbacks.map((rollback) => rollback()));
      throw error;
    }
  }

  /** Replace a cached response derived from a canonical mutation response. */
  private async updateRemoteReplica<T>(
    path: string,
    updater: (current: T) => T,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<void> {
    const current = await this.readReplica<T>(path, query);
    if (current === undefined) return;
    await this.replaceReplica(path, updater(current), query);
  }

  /**
   * A document can be addressed by either its stable id or its mutable slug.
   * Keep both cached GET aliases in sync when a mutation returns a canonical
   * representation so all document views observe the same replica update.
   */
  private async replaceDocumentReplica(
    spaceId: string,
    document: DocumentWithProperties,
  ): Promise<void> {
    const documentKey = this.documentReplicaKey(spaceId, document.id);
    const aliasKey = this.documentAliasKey(spaceId, document.slug);
    if (!documentKey || !aliasKey) return;

    const previous = await this.responseReplica.get<{
      document: DocumentWithProperties;
    }>(documentKey);
    await this.responseReplica.replaceRemote(documentKey, { document });

    const previousSlug = previous?.value.document.slug;
    if (previousSlug && previousSlug !== document.slug) {
      const previousAliasKey = this.documentAliasKey(spaceId, previousSlug);
      if (previousAliasKey) await this.responseReplica.removeRemote(previousAliasKey);
    }
    await this.responseReplica.replaceRemote(aliasKey, { documentId: document.id });
  }

  private async applyOptimisticDocumentReplica(
    spaceId: string,
    documentId: string,
    updater: (
      current: { document: DocumentWithProperties } | undefined,
    ) => { document: DocumentWithProperties } | undefined,
  ): Promise<OptimisticReplicaOperation<{ document: DocumentWithProperties }> | null> {
    const current = await this.readDocumentReplica(spaceId, documentId);
    const documentKey = this.documentReplicaKey(spaceId, current?.id ?? documentId);
    if (!documentKey) return null;

    return await this.responseReplica.applyOptimistic(documentKey, updater);
  }

  private async optimisticDocumentReplica(
    spaceId: string,
    documentId: string,
    updater: (
      current: { document: DocumentWithProperties } | undefined,
    ) => { document: DocumentWithProperties } | undefined,
  ): Promise<ReplicaRollback> {
    const operation = await this.applyOptimisticDocumentReplica(
      spaceId,
      documentId,
      updater,
    );
    return async () => await this.rollbackOptimisticReplica(operation);
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
    const finalUrl = this.buildUrl(base, path, query);
    const method = (fetchOptions.method ?? "GET").toUpperCase();
    // Capture the identity before the request starts. A logout/login during an
    // in-flight request must not write the prior user's response into the new
    // replica scope.
    const responseReplicaKey = this.isReplicatedRead(method, path)
      ? this.replicaKey(finalUrl)
      : null;

    const response = await fetch(finalUrl, {
      ...fetchOptions,
      headers: {
        ...fetchOptions.headers,
        ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
      },
    });

    if (!response.ok) {
      const responseBody = await response.text();
      let message: string | undefined;
      try {
        const body = JSON.parse(responseBody) as { error?: unknown };
        if (typeof body.error === "string") {
          message = body.error;
        }
      } catch {}
      throw new Error(message ?? responseBody);
    }

    const data = (await response.json()) as T;
    if (responseReplicaKey) {
      await this.responseReplica.replaceRemote(responseReplicaKey, data);
    }

    return data;
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

    getCached: async () => {
      return await this.readReplica<Space[]>("/api/v1/spaces");
    },

    subscribeCached: (callback: (spaces: Space[] | undefined) => void) => {
      return this.subscribeToReplica<Space[]>("/api/v1/spaces", callback);
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
      await this.updateRemoteReplica<Space[]>("/api/v1/spaces", (spaces) => [
        ...spaces.filter((space) => space.id !== response.space.id),
        response.space,
      ]);
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
      const detailPath = `/api/v1/spaces/${spaceId}`;
      const listPath = "/api/v1/spaces";
      return await this.withOptimisticReplica(
        () =>
          Promise.all([
            this.optimisticReplica<Space>(detailPath, (space) =>
              space ? { ...space, ...body } : space,
            ),
            this.optimisticReplica<Space[]>(listPath, (spaces) =>
              spaces?.map((space) =>
                space.id === spaceId ? { ...space, ...body } : space,
              ),
            ),
          ]),
        () => this.apiPatch<Space>(this.baseUrl, detailPath, body),
        async (space) => {
          await Promise.all([
            this.replaceReplica(detailPath, space),
            this.updateRemoteReplica<Space[]>(listPath, (spaces) =>
              spaces.map((current) =>
                current.id === spaceId ? { ...current, ...space } : current,
              ),
            ),
          ]);
        },
      );
    },

    /**
     * Delete a space
     */
    delete: async (spaceId: string) => {
      const listPath = "/api/v1/spaces";
      await this.withOptimisticReplica(
        () =>
          this.optimisticReplica<Space[]>(listPath, (spaces) =>
            spaces?.filter((space) => space.id !== spaceId),
          ),
        () => this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}`),
        async () => {
          await this.updateRemoteReplica<Space[]>(listPath, (spaces) =>
            spaces.filter((space) => space.id !== spaceId),
          );
        },
      );
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
        resourceType?: PermissionResourceType;
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
        /** Invite by email: resolved server-side to a user id (404 if none). */
        email?: string;
        groupId?: string;
        resourceType?: PermissionResourceType;
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
        resourceType?: PermissionResourceType;
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

    getCached: async (spaceId: string) => {
      return (
        await this.readReplica<{ categories: Category[] }>(
          `/api/v1/spaces/${spaceId}/categories`,
        )
      )?.categories;
    },

    subscribeCached: (
      spaceId: string,
      callback: (categories: Category[] | undefined) => void,
    ) => {
      return this.subscribeToReplica<{ categories: Category[] }>(
        `/api/v1/spaces/${spaceId}/categories`,
        (response) => callback(response?.categories),
      );
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
      await this.updateRemoteReplica<{ categories: Category[] }>(
        `/api/v1/spaces/${spaceId}/categories`,
        (cached) => ({
          ...cached,
          categories: [
            ...cached.categories.filter(
              (category) => category.id !== response.category.id,
            ),
            response.category,
          ],
        }),
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
      // The reorder endpoint does not return the canonical list, so re-fetch it
      // rather than treating the local ordering as authoritative.
      if (await this.readReplica(`/api/v1/spaces/${spaceId}/categories`)) {
        await this.categories.get(spaceId);
      }
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
      const detailPath = `/api/v1/spaces/${spaceId}/categories/${id}`;
      const listPath = `/api/v1/spaces/${spaceId}/categories`;
      const response = await this.withOptimisticReplica(
        () =>
          Promise.all([
            this.optimisticReplica<{ category: Category }>(detailPath, (cached) =>
              cached ? { category: { ...cached.category, ...body } } : cached,
            ),
            this.optimisticReplica<{ categories: Category[] }>(listPath, (cached) =>
              cached
                ? {
                    ...cached,
                    categories: cached.categories.map((category) =>
                      category.id === id ? { ...category, ...body } : category,
                    ),
                  }
                : cached,
            ),
          ]),
        () => this.apiPut<{ category: Category }>(this.baseUrl, detailPath, body),
        async (response) => {
          await Promise.all([
            this.replaceReplica(detailPath, response),
            this.updateRemoteReplica<{ categories: Category[] }>(listPath, (cached) => ({
              ...cached,
              categories: cached.categories.map((category) =>
                category.id === id ? response.category : category,
              ),
            })),
          ]);
        },
      );
      return response.category;
    },

    /**
     * Delete a category
     */
    delete: async (spaceId: string, id: string) => {
      const listPath = `/api/v1/spaces/${spaceId}/categories`;
      await this.withOptimisticReplica(
        () =>
          this.optimisticReplica<{ categories: Category[] }>(listPath, (cached) =>
            cached
              ? {
                  ...cached,
                  categories: cached.categories.filter((category) => category.id !== id),
                }
              : cached,
          ),
        () => this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/categories/${id}`),
        async () => {
          await this.updateRemoteReplica<{ categories: Category[] }>(
            listPath,
            (cached) => ({
              ...cached,
              categories: cached.categories.filter((category) => category.id !== id),
            }),
          );
        },
      );
    },
  };

  documents = {
    /**
     * List documents in a space
     */
    get: async (
      spaceId: string,
      query?: { limit?: number; cursor?: string; type?: string } & Record<
        string,
        string | number | boolean | undefined
      >,
    ) => {
      const response = await this.apiGet<{
        documents: DocumentWithProperties[];
        total: number;
        limit: number;
        nextCursor: string | null;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents`, query);
      return response;
    },

    getCached: async (
      spaceId: string,
      query?: { limit?: number; cursor?: string; type?: string } & Record<
        string,
        string | number | boolean | undefined
      >,
    ) => {
      return await this.readReplica<{
        documents: DocumentWithProperties[];
        total: number;
        limit: number;
        nextCursor: string | null;
      }>(this.documentsPath(spaceId), query);
    },

    subscribeCached: (
      spaceId: string,
      callback: (
        response:
          | {
              documents: DocumentWithProperties[];
              total: number;
              limit: number;
              nextCursor: string | null;
            }
          | undefined,
      ) => void,
      query?: { limit?: number; cursor?: string; type?: string } & Record<
        string,
        string | number | boolean | undefined
      >,
    ) => {
      return this.subscribeToReplica<{
        documents: DocumentWithProperties[];
        total: number;
        limit: number;
        nextCursor: string | null;
      }>(this.documentsPath(spaceId), callback, query);
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
        categorySlugs: this.categorySlugsQuery(categorySlugs),
        grouped: true,
      });
      return response.documentsByCategory;
    },

    getByCategoriesCached: async (spaceId: string, categorySlugs: string[]) => {
      return (
        await this.readReplica<{
          documentsByCategory: Record<string, DocumentWithProperties[]>;
          categorySlugs: string[];
        }>(this.documentsPath(spaceId), {
          categorySlugs: this.categorySlugsQuery(categorySlugs),
          grouped: true,
        })
      )?.documentsByCategory;
    },

    subscribeByCategoriesCached: (
      spaceId: string,
      categorySlugs: string[],
      callback: (
        documentsByCategory: Record<string, DocumentWithProperties[]> | undefined,
      ) => void,
    ) => {
      return this.subscribeToReplica<{
        documentsByCategory: Record<string, DocumentWithProperties[]>;
        categorySlugs: string[];
      }>(
        this.documentsPath(spaceId),
        (response) => callback(response?.documentsByCategory),
        {
          categorySlugs: this.categorySlugsQuery(categorySlugs),
          grouped: true,
        },
      );
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
      await this.replaceDocumentReplica(spaceId, response.document);
      return response.document;
    },
  };

  document = {
    getEmailPreference: async (spaceId: string, documentId: string) => {
      return await this.apiGet<{ muted: boolean }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/email-preference`,
      );
    },

    setEmailMuted: async (spaceId: string, documentId: string, muted: boolean) => {
      return await this.apiPatch<{ muted: boolean }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/email-preference`,
        { muted },
      );
    },

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
      await this.replaceDocumentReplica(spaceId, response.document);
      return response.document;
    },

    getCached: async (spaceId: string, documentIdOrSlug: string) => {
      return await this.readDocumentReplica(spaceId, documentIdOrSlug);
    },

    subscribeCached: (
      spaceId: string,
      documentIdOrSlug: string,
      callback: (document: DocumentWithProperties | undefined) => void,
    ) => {
      return this.subscribeToDocumentReplica(spaceId, documentIdOrSlug, callback);
    },

    /**
     * Update document content (PUT)
     */
    put: async (
      spaceId: string,
      documentId: string,
      content: string,
      options?: { publish?: boolean },
    ) => {
      const detailPath = `/api/v1/spaces/${spaceId}/documents/${documentId}`;
      const requestPath = options?.publish ? `${detailPath}?publish=true` : detailPath;
      const response = await this.withOptimisticReplica(
        () =>
          this.optimisticDocumentReplica(spaceId, documentId, (cached) =>
            cached
              ? {
                  document: {
                    ...cached.document,
                    content,
                    ...(options?.publish
                      ? { publishedRev: cached.document.publishedRev ?? 0 }
                      : {}),
                  },
                }
              : cached,
          ),
        async () => {
          const response = await fetch(`${this.baseUrl}${requestPath}`, {
            method: "PUT",
            headers: {
              "Content-Type": "text/html",
              ...(this.accessToken
                ? { Authorization: `Bearer ${this.accessToken}` }
                : {}),
            },
            body: content,
          });

          if (!response.ok) {
            const error = await response.text();
            throw new Error(`API request failed: ${response.status} ${error}`);
          }

          return (await response.json()) as {
            document: Omit<DocumentWithProperties, "content">;
          };
        },
        async (response) => {
          // The PUT response intentionally omits `content` to avoid echoing the
          // whole (potentially tens-of-MB) document back. We already hold the
          // canonical content — it's exactly what we just sent — so merge it
          // onto the server metadata when refreshing the replica.
          await this.replaceDocumentReplica(spaceId, {
            ...response.document,
            content,
          });
        },
      );
      return { ...response.document, content };
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
      const detailPath = `/api/v1/spaces/${spaceId}/documents/${documentId}`;
      return await this.withOptimisticReplica(
        () =>
          this.optimisticDocumentReplica(spaceId, documentId, (cached) => {
            if (!cached) return cached;

            const properties = { ...cached.document.properties };
            for (const [key, patch] of Object.entries(body.properties ?? {})) {
              if (patch === null) {
                delete properties[key];
                continue;
              }
              const value =
                typeof patch === "object" && !Array.isArray(patch) && "value" in patch
                  ? patch.value
                  : patch;
              if (typeof value === "string" || Array.isArray(value)) {
                properties[key] = value;
              } else {
                properties[key] = String(value);
              }
            }

            return {
              document: {
                ...cached.document,
                ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
                ...(body.publishedRev !== undefined
                  ? { publishedRev: body.publishedRev }
                  : {}),
                ...(body.readonly !== undefined ? { readonly: body.readonly } : {}),
                properties,
              },
            };
          }),
        () =>
          this.apiPatch<{ success?: boolean; slug?: string }>(
            this.baseUrl,
            detailPath,
            body,
          ),
        async () => {
          // PATCH returns only acknowledgement metadata. Fetch the server's full
          // representation so it replaces the optimistic document exactly.
          await this.document.get(spaceId, documentId).catch(() => undefined);
        },
      );
    },

    /**
     * Update document content via JSON body (used for code/workflow documents)
     */
    putCode: async (
      spaceId: string,
      documentId: string,
      content: string,
    ): Promise<void> => {
      const detailPath = `/api/v1/spaces/${spaceId}/documents/${documentId}`;
      await this.withOptimisticReplica(
        () =>
          this.optimisticDocumentReplica(spaceId, documentId, (cached) =>
            cached ? { document: { ...cached.document, content } } : cached,
          ),
        () => this.apiPut<unknown>(this.baseUrl, detailPath, { content }),
        async () => {
          await this.document.get(spaceId, documentId).catch(() => undefined);
        },
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
    patch: async (
      spaceId: string,
      documentId: string,
      rev: number,
      body: { status: RevisionSuggestionStatus },
    ) => {
      const response = await this.apiPatch<{ revision: RevisionMetadata }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/revisions?rev=${rev}`,
        body,
      );
      return response.revision;
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

  documentBreadcrumbs = {
    get: async (spaceId: string, documentId: string) => {
      const response = await this.apiGet<{
        breadcrumbs: Array<{
          id: string;
          slug: string;
          title: string;
          categorySlug?: string;
        }>;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents/${documentId}/breadcrumbs`);
      return response.breadcrumbs;
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
      options?: { onProgress?: (progress: number) => void },
    ) => {
      const formData = new FormData();
      formData.append("file", file, filename);
      if (documentId) {
        formData.append("documentId", documentId);
      }

      // Use XMLHttpRequest instead of fetch so we can report upload progress.
      // fetch has no way to observe how much of the request body has been sent.
      return await new Promise<{ url: string; [key: string]: unknown }>(
        (resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", `/api/v1/spaces/${spaceId}/uploads`);

          if (options?.onProgress) {
            xhr.upload.addEventListener("progress", (event) => {
              if (event.lengthComputable) {
                options.onProgress?.(event.loaded / event.total);
              }
            });
          }

          xhr.addEventListener("load", () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              try {
                resolve(JSON.parse(xhr.responseText));
              } catch (_err) {
                reject(new Error("Upload failed: invalid server response"));
              }
            } else {
              reject(new Error(`Upload failed: ${xhr.status} ${xhr.responseText}`));
            }
          });

          xhr.addEventListener("error", () => {
            reject(new Error("Upload failed: network error"));
          });

          xhr.send(formData);
        },
      );
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

  agentSettings = {
    get: async (spaceId: string) => {
      return await this.apiGet<{ aiProvider: AIConfigMeta }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/settings/ai-provider`,
      );
    },

    put: async (
      spaceId: string,
      body:
        | {
            provider: "anthropic" | "openai" | "openrouter" | "opencode-zen";
            model: string;
            apiKey: string;
          }
        | { provider: "ollama"; model: string; baseUrl: string },
    ) => {
      return await this.apiPut<{ aiProvider: AIConfigMeta }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/settings/ai-provider`,
        body,
      );
    },

    delete: async (spaceId: string) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/settings/ai-provider`,
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

    getCached: async (
      spaceId: string,
    ): Promise<
      { extensions: ExtensionInfo[]; errors: ExtensionManifestError[] } | undefined
    > => {
      const response = await this.readReplica<{
        extensions: ExtensionInfo[];
        errors?: ExtensionManifestError[];
      }>(`/api/v1/spaces/${spaceId}/extensions`);
      if (!response) return undefined;
      return {
        extensions: response.extensions ?? [],
        errors: response.errors ?? [],
      };
    },

    subscribeCached: (
      spaceId: string,
      callback: (
        response:
          | { extensions: ExtensionInfo[]; errors: ExtensionManifestError[] }
          | undefined,
      ) => void,
    ) => {
      return this.subscribeToReplica<{
        extensions: ExtensionInfo[];
        errors?: ExtensionManifestError[];
      }>(`/api/v1/spaces/${spaceId}/extensions`, (response) => {
        callback(
          response
            ? {
                extensions: response.extensions ?? [],
                errors: response.errors ?? [],
              }
            : undefined,
        );
      });
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
     * Enable or disable an extension
     */
    update: async (
      spaceId: string,
      extensionId: string,
      body: { enabled: boolean },
    ): Promise<ExtensionInfo> => {
      return await this.apiPatch<ExtensionInfo>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/extensions/${extensionId}`,
        body,
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

    /**
     * Download the raw extension ZIP package
     */
    downloadPackage: async (spaceId: string, extensionId: string): Promise<Blob> => {
      const response = await fetch(
        `/api/v1/spaces/${spaceId}/extensions/${extensionId}/package`,
      );
      if (!response.ok) {
        const error = await response.json().catch(() => ({ error: "Download failed" }));
        throw new Error(error.error || `Download failed: ${response.status}`);
      }
      return await response.blob();
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
      video: string | null;
      siteName: string | null;
      favicon: string | null;
      updatedAt: string | null;
      fetchedAt: number;
      vektorDocument?: {
        address: string;
        documentId: string;
        documentSlug: string;
        spaceId: string;
        spaceSlug: string;
        spaceName: string;
        type: string;
        content: string;
      };
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

    getCached: async (spaceId: string, documentId: string) => {
      return (
        await this.readReplica<{ comments: Comment[] }>(
          this.documentCommentsPath(spaceId, documentId),
        )
      )?.comments;
    },

    subscribeCached: (
      spaceId: string,
      documentId: string,
      callback: (comments: Comment[] | undefined) => void,
    ) => {
      return this.subscribeToReplica<{ comments: Comment[] }>(
        this.documentCommentsPath(spaceId, documentId),
        (response) => callback(response?.comments),
      );
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
      const path = `/api/v1/spaces/${spaceId}/documents/${documentId}/comments`;
      const optimisticId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `optimistic-${crypto.randomUUID()}`
          : `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = new Date().toISOString();
      const optimisticComment: Comment = {
        id: optimisticId,
        documentId,
        content: body.content,
        reference: body.reference,
        parentId: body.parentId,
        type: body.type,
        createdAt: now,
        createdBy: "",
        updatedAt: now,
        updatedBy: "",
      };
      const response = await this.withOptimisticReplica(
        () =>
          this.optimisticReplica<{ comments: Comment[] }>(path, (cached) =>
            cached
              ? { ...cached, comments: [...cached.comments, optimisticComment] }
              : cached,
          ),
        () => this.apiPost<{ comment: Comment }>(this.baseUrl, path, body),
        async (response) => {
          await this.updateRemoteReplica<{ comments: Comment[] }>(path, (cached) => ({
            ...cached,
            comments: [
              ...cached.comments.filter((comment) => comment.id !== optimisticId),
              response.comment,
            ],
          }));
        },
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
      const path = `/api/v1/spaces/${spaceId}/documents/${documentId}/comments`;
      await this.withOptimisticReplica(
        () =>
          this.optimisticReplica<{ comments: Comment[] }>(path, (cached) =>
            cached
              ? {
                  ...cached,
                  comments: cached.comments.map((comment) =>
                    body.commentIds.includes(comment.id)
                      ? { ...comment, reference: body.reference }
                      : comment,
                  ),
                }
              : cached,
          ),
        () => this.apiPatch<{ success: boolean }>(this.baseUrl, path, body),
        async () => {
          await this.documentComments.get(spaceId, documentId).catch(() => undefined);
        },
      );
    },

    /**
     * Resolve (archive) a thread — all comments sharing the same reference
     */
    resolve: async (spaceId: string, documentId: string, commentIds: string[]) => {
      const path = `/api/v1/spaces/${spaceId}/documents/${documentId}/comments`;
      await this.withOptimisticReplica(
        () =>
          this.optimisticReplica<{ comments: Comment[] }>(path, (cached) =>
            cached
              ? {
                  ...cached,
                  comments: cached.comments.filter(
                    (comment) => !commentIds.includes(comment.id),
                  ),
                }
              : cached,
          ),
        () =>
          this.apiPatch<{ success: boolean }>(this.baseUrl, path, {
            commentIds,
            archived: true,
          }),
        async () => {
          await this.documentComments.get(spaceId, documentId).catch(() => undefined);
        },
      );
    },

    /**
     * Delete a comment
     */
    delete: async (spaceId: string, documentId: string, commentId: string) => {
      const path = `/api/v1/spaces/${spaceId}/documents/${documentId}/comments`;
      await this.withOptimisticReplica(
        () =>
          this.optimisticReplica<{ comments: Comment[] }>(path, (cached) =>
            cached
              ? {
                  ...cached,
                  comments: cached.comments.filter((comment) => comment.id !== commentId),
                }
              : cached,
          ),
        () =>
          this.apiFetch<void>(this.baseUrl, path, {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ commentId }),
          }),
        async () => {
          await this.updateRemoteReplica<{ comments: Comment[] }>(path, (cached) => ({
            ...cached,
            comments: cached.comments.filter((comment) => comment.id !== commentId),
          }));
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
      options?: { sourceExtensionId?: string },
    ): Promise<{ runId: string }> => {
      return await this.apiPost<{ runId: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/runs`,
        {
          documentId,
          inputs,
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
          sourceExtensionId: string | null;
          runtimeInputs: Record<string, unknown>;
        }[];
        total: number;
        limit: number;
        offset: number;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/workflows/runs`, query);
      return response;
    },

    /**
     * List cron schedules that run workflow documents in a space
     */
    listSchedules: async (spaceId: string) => {
      return await this.apiGet<{ schedules: WorkflowSchedule[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/schedules`,
      );
    },

    /**
     * Create a schedule that runs a workflow document on a cron expression
     */
    createSchedule: async (
      spaceId: string,
      body: {
        documentId: string;
        cronExpression: string;
        timezone?: string;
        inputs?: Record<string, unknown>;
        enabled?: boolean;
      },
    ) => {
      return await this.apiPost<{ schedule: WorkflowSchedule }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/schedules`,
        body,
      );
    },

    /**
     * Update a workflow schedule
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
      return await this.apiPatch<{ schedule: WorkflowSchedule }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/schedules/${scheduleId}`,
        body,
      );
    },

    /**
     * Delete a workflow schedule (run history is preserved)
     */
    deleteSchedule: async (spaceId: string, scheduleId: string) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/schedules/${scheduleId}`,
      );
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
  };

  aiChatSessions = {
    list: async (spaceId: string): Promise<AIChatSession[]> => {
      const { sessions } = await this.apiFetch<{ sessions: AIChatSession[] }>(
        this.baseUrl,
        `/api/v1/spaces/${encodeURIComponent(spaceId)}/ai-chat/sessions`,
        { credentials: "same-origin" },
      );
      return sessions;
    },

    get: async (spaceId: string, sessionId: string): Promise<AIChatSession | null> => {
      const response = await fetch(
        `${this.baseUrl}/api/v1/spaces/${encodeURIComponent(spaceId)}/ai-chat/sessions/${encodeURIComponent(sessionId)}`,
        { credentials: "same-origin" },
      );
      if (response.status === 404) return null;
      if (!response.ok)
        throw new Error(
          `API request failed: ${response.status} ${await response.text()}`,
        );
      const { session } = (await response.json()) as { session: AIChatSession };
      return session;
    },

    save: async (session: AIChatSession): Promise<void> => {
      await this.apiFetch<{ session: AIChatSession }>(
        this.baseUrl,
        `/api/v1/spaces/${encodeURIComponent(session.spaceId)}/ai-chat/sessions/${encodeURIComponent(session.id)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(session),
        },
      );
    },

    delete: async (spaceId: string, sessionId: string): Promise<void> => {
      await this.apiFetch<{ success: true }>(
        this.baseUrl,
        `/api/v1/spaces/${encodeURIComponent(spaceId)}/ai-chat/sessions/${encodeURIComponent(sessionId)}`,
        { method: "DELETE", credentials: "same-origin" },
      );
    },

    cancel: async (spaceId: string, sessionId: string): Promise<void> => {
      await this.apiFetch<void>(this.baseUrl, "/api/v1/chat/acp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "session/cancel",
          params: { sessionId, spaceId },
        }),
      });
    },
  };

  documentDiff = {
    get: async (
      spaceId: string,
      documentId: string,
      rev: string,
      format?: "html",
    ): Promise<string> => {
      const formatQuery = format ? `&format=${encodeURIComponent(format)}` : "";
      const response = await fetch(
        `${this.baseUrl}/api/v1/spaces/${encodeURIComponent(spaceId)}/documents/${encodeURIComponent(documentId)}/diff?rev=${encodeURIComponent(rev)}${formatQuery}`,
        { credentials: "same-origin" },
      );
      if (!response.ok)
        throw new Error(
          `API request failed: ${response.status} ${await response.text()}`,
        );
      return response.text();
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
        for (const entry of ydocs) {
          applyUpdate(entry.ydoc, update, "remote");
          const onSynced = entry.onSynced;
          entry.onSynced = undefined;
          onSynced?.();
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
  private sendRealtimeState(
    connection: RealtimeConnection,
    data: Uint8Array<ArrayBuffer>,
  ): void {
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(data);
    }
  }

  /**
   * Send ephemeral messages (presence/yjs updates) that are not part of replayed
   * state. Best-effort: sent immediately when open, otherwise once the socket
   * opens. Guards against "WebSocket is already in CLOSING or CLOSED state".
   */
  private sendRealtimeEphemeral(
    connection: RealtimeConnection,
    data: Uint8Array<ArrayBuffer>,
  ): void {
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

  joinYjsRoom(
    spaceId: string,
    documentId: string,
    ydoc: YDoc,
    onSynced?: () => void,
  ): () => void {
    if (!(ydoc instanceof YDoc)) {
      console.warn("Ignoring Yjs room join without a Y.Doc", { documentId, spaceId });
      return () => {};
    }

    const connection = this.getRealtimeConnection(spaceId);

    let ydocs = connection.yjsRooms.get(documentId);
    const entry: YjsRoomEntry = { ydoc, onSynced };
    if (!ydocs) {
      ydocs = new Set();
      connection.yjsRooms.set(documentId, ydocs);
      ydocs.add(entry);
      // First doc for this room — announce the join (replayed on reconnect).
      this.sendRealtimeState(connection, wsEncode(WsMsgType.YjsJoin, { documentId }));
    } else {
      const source = ydocs.values().next().value;
      if (source) {
        applyUpdate(ydoc, encodeStateAsUpdate(source.ydoc), "remote");
        queueMicrotask(() => {
          entry.onSynced = undefined;
          onSynced?.();
        });
      }
      ydocs.add(entry);
    }

    const handleUpdate = (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return;
      const rooms = connection.yjsRooms.get(documentId);
      if (rooms) {
        for (const peer of rooms) {
          if (peer !== entry) {
            applyUpdate(peer.ydoc, update, "remote");
          }
        }
      }
      this.sendRealtimeEphemeral(connection, wsEncodeYjsUpdate(documentId, update));
    };

    ydoc.on("update", handleUpdate);

    return () => {
      ydoc.off("update", handleUpdate);
      const rooms = connection.yjsRooms.get(documentId);
      if (rooms) {
        rooms.delete(entry);
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
    connection.presenceSubscriptions.add(subscription as PresenceSubscription<unknown>);

    const presenceKey = `${room}:${clientId}`;
    const joinPayload: PresenceJoinPayload<TState> = {
      room,
      clientId,
      user,
      state: initialState,
    };
    // Remember the join so it can be replayed after a reconnect; its `state`
    // is kept current by `update` below.
    connection.presenceJoinPayloads.set(
      presenceKey,
      joinPayload as PresenceJoinPayload<unknown>,
    );
    this.sendRealtimeState(connection, wsEncode(WsMsgType.PresenceJoin, joinPayload));

    const update = (state: TState) => {
      const stored = connection.presenceJoinPayloads.get(presenceKey);
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
      connection.presenceSubscriptions.delete(
        subscription as PresenceSubscription<unknown>,
      );
      connection.presenceJoinPayloads.delete(presenceKey);
      this.sendRealtimeState(
        connection,
        wsEncode(WsMsgType.PresenceLeave, { room, clientId }),
      );

      this.maybeCloseRealtimeConnection(connection);
    };

    return { update, leave };
  }
}
