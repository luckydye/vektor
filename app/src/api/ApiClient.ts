import {
  applyUpdate,
  decodeStateVector,
  encodeStateAsUpdate,
  encodeStateVector,
  encodeStateVectorFromUpdate,
  Doc as YDoc,
} from "yjs";
import type { PublicUserAppearance } from "#cosmetics/types.ts";
import type { DocumentProperties } from "#documents/properties.ts";
import {
  type PresenceJoinPayload,
  type PresenceLeaveMessage,
  type PresenceMessage,
  type PresenceSnapshotMessage,
  type PresenceUpdateMessage,
  type PresenceUpdatePayload,
  type PresenceUser,
  type RealtimeAccessChangedMessage,
  type RealtimeErrorPayload,
  type RealtimeEventMessage,
  type RealtimeTopic,
  realtimeTopics,
  type SyncCursor,
  WS_CLOSE_FORBIDDEN,
  WsMsgType,
  wsDecode,
  wsDecodeJson,
  wsDecodeYjsUpdate,
  wsEncode,
  wsEncodeYjsUpdate,
} from "#realtime/protocol.ts";
import { ReplicaCache } from "./ReplicaCache.ts";
import type { ReplicaOperation } from "./ReplicaDb.ts";

export interface User {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  appearance?: PublicUserAppearance;
}

/**
 * The signed-in caller, as only `users/me` can report them: their profile plus
 * the things they may do that no space's `permissions/me` covers.
 */
export interface CurrentUser extends User {
  canCreateSpace: boolean;
  /** The caller's own instance-admin groups; empty unless they administer it. */
  adminGroups: string[];
  /** Whether the caller administers the instance — see `users/me`. */
  isAdmin: boolean;
}

/**
 * A register entry: an account as an instance admin sees it, which is more than
 * the {@link User} the scoped forms of `/users` return — the email of someone
 * they share no space with, and the group claim their access is decided by.
 */
export interface InstanceUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  /** The stored IdP group claim, without the synthetic `public`. */
  groups: string[];
  createdAt: Date | string;
}

export interface Space {
  id: string;
  name: string;
  slug: string;
  createdBy: string;
  /** The space's own preferences, the same for every member. */
  preferences: Record<string, string>;
  /**
   * The requester's own preferences for this space — the `user:` namespace, kept
   * in per-user rows. Written through the same `preferences` body as the space's.
   */
  userPreferences?: Record<string, string>;
  createdAt: Date | string;
  updatedAt: Date | string;
  userRole?: string;
  memberCount?: number;
  /**
   * Listings only: reachable because the caller administers the instance rather
   * than because a grant in the space names them.
   */
  adminAccess?: boolean;
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
  /** Archived documents are hidden from listings but still readable. */
  archived?: boolean;
  parentId?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
  createdBy: string;
  updatedBy: string;
  fileUrl?: string;
  /** Set for file-table entries: the stored size in bytes, where it is known */
  fileSize?: number;
}

export interface DocumentWithProperties extends Document {
  properties: DocumentProperties;
  mentionCount?: number;
  /** Natural width/height ratio derived from the stored header image. */
  headerImageAspectRatio?: number | null;
  locked?: boolean;
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

/**
 * A revision read back with its content. Everything describing the revision is
 * withheld from a caller without VIEW_HISTORY, so only these three are certain.
 */
export type RevisionWithContent = Partial<Revision> &
  Pick<Revision, "rev" | "status"> & { content: string };

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

export interface CategoriesListResponse {
  categories: Category[];
  // True when the space has categories this user isn't able to see — lets
  // the UI distinguish "no categories exist" from "you have no access".
  hasHiddenCategories: boolean;
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

/** @deprecated Use "standalone". Kept so existing extension manifests continue to work. */
export type DeprecatedPageExtensionPlacement = "page";

export interface ExtensionRoute {
  path: string;
  title?: string;
  description?: string;
  menuItem?: ExtensionRouteMenuItem;
  /** Where this view should be placed. Can include "standalone" (default), "inline" for Add Content blocks, "document" beside standard documents, or "database" as a selectable database view. */
  placements?: Array<
    "standalone" | "inline" | "document" | "database" | DeprecatedPageExtensionPlacement
  >;
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

/** A token the caller issued for itself, and the space it opens. */
export interface PersonalAccessToken extends AccessToken {
  spaceId: string;
  spaceName: string;
}

export interface ShareLink {
  id: string;
  name: string | null;
  resourceType: string;
  resourceId: string;
  hasPassword: boolean;
  expiresAt: Date | string | null;
  lastUsedAt: Date | string | null;
  createdAt: Date | string;
  createdBy: string | null;
  revokedAt: Date | string | null;
  resource?: {
    title: string;
    slug: string;
    archived: boolean;
  } | null;
}

/**
 * One row of the ACL as the permissions endpoint returns it.
 *
 * Note this is the whole `AclEntry`, not the `permission` column alone.
 */
export interface PermissionEntry {
  type: "role" | "feature";
  permission: {
    resourceType?: PermissionResourceType;
    resourceId?: string;
    userId?: string;
    groupId?: string;
    permission: string;
    createdAt?: string | Date;
    updatedAt?: string | Date;
    /** Set when the grant is a credential's rather than a person's or a group's. */
    kind?: string | null;
  };
}

/** One grant that reaches a document, and how it gets there. */
export interface DocumentAccessGrant {
  resourceType: PermissionResourceType;
  resourceId: string;
  /** The grant is on an ancestor page, a category, or the space — not this page. */
  inherited: boolean;
  /** Page title or category name of the resource the grant sits on. */
  resourceLabel?: string;
  permission: string;
  createdAt?: string | Date;
}

/** One grantee's effective access to a document. */
export interface DocumentAccessEntry {
  userId?: string;
  groupId?: string;
  /** Effective role on the document, with scoped grants overriding space role. */
  permission: string;
  /** The grant that decides `permission`. */
  via: DocumentAccessGrant;
  grants: DocumentAccessGrant[];
}

export type PermissionResourceType =
  | "space"
  | "document"
  | "document_tree"
  | "category"
  | "extension"
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

/** Provider ids are declared by installed extensions, not by the app. */
export type OAuthIntegrationProvider = string;

export interface OAuthIntegrationConnection {
  provider: OAuthIntegrationProvider;
  label: string;
  description: string | null;
  extensionId: string;
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
  targetUserId?: string;
  targetGroupId?: string;
  targetName?: string;
  resourceType?: string;
  resourceId?: string;
}

export interface GitTreeEntry {
  name: string;
  path: string;
  type: "blob" | "tree";
  size: number | null;
}

export interface GitCommit {
  oid: string;
  shortOid: string;
  subject: string;
  author: string;
  authoredAt: string;
  /** Parent object ids, first-parent first; empty for a root commit. */
  parents: string[];
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

export interface PropertyFilter {
  key: string;
  /** A string matches that exact value; null matches any document that has the property. */
  value: string | null;
}

export interface SearchResult {
  id: string;
  slug: string;
  type?: string | null;
  content: string;
  properties: DocumentProperties;
  createdAt: string;
  updatedAt: string;
  userId: string;
  parentId: string | null;
  rank: number;
  snippet: string;
  /** Set for file-table entries — use this URL instead of the doc route */
  fileUrl?: string;
  /** Set for file-table entries: the stored size in bytes, where it is known */
  fileSize?: number;
}

/**
 * A result from a space other than the one being searched. Carries no branding:
 * the space's logo and color come from the cached space listing.
 */
export type CrossSpaceSearchResult = SearchResult & {
  spaceId: string;
  spaceName: string;
  spaceSlug: string;
};

export interface Comment {
  id: string;
  /** The resource the comment hangs off — a document id, for every caller here. */
  resourceType: string | null;
  resourceId: string | null;
  content: string;
  reference: string | null;
  parentId: string | null;
  type: string;
  createdAt: Date | string;
  createdBy: string;
  updatedAt: Date | string;
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

/** A session as the picker lists it — see `AIChatSessionSummary` on the server. */
export interface AIChatSessionListEntry {
  id: string;
  title: string;
  spaceId: string;
  createdAt: number;
  updatedAt: number;
  lastMessageRole: string | null;
}

/**
 * How long an unsubscribed realtime connection is kept before it is closed.
 *
 * Long enough to cover an unsubscribe and resubscribe that straddle a task —
 * an effect re-running, a route swapping the only subscriber — and short enough
 * that leaving a space does not hold a socket anyone would notice.
 */
const REALTIME_IDLE_GRACE_MS = 2_000;

/**
 * How often the client probes its socket, and how long it waits for the answer.
 * A dropped socket stays in `readyState` OPEN with no `close` ever firing, so
 * without this round trip the connection is silently dead until a reload.
 */
const REALTIME_PING_INTERVAL_MS = 25_000;
const REALTIME_PONG_TIMEOUT_MS = 10_000;

/** Prevent an accept-then-refuse socket from resetting reconnect backoff. */
const RECONNECT_SETTLED_MS = 5_000;

interface RealtimeSubscription {
  topics: Set<RealtimeTopic>;
  callback: (event: RealtimeEventMessage) => void;
}

function sharesNoHistory(ydoc: YDoc, update: Uint8Array): boolean {
  let local: Map<number, number>;
  let incoming: Map<number, number>;
  try {
    local = decodeStateVector(encodeStateVector(ydoc));
    incoming = decodeStateVector(encodeStateVectorFromUpdate(update));
  } catch {
    return false;
  }
  if (local.size === 0 || incoming.size === 0) return false;
  for (const client of incoming.keys()) {
    if (local.has(client)) return false;
  }
  return true;
}

interface YjsRoomEntry {
  ydoc: YDoc;
  onReset?: () => void;
  onSynced?: () => void;
  /** Both are cleared on the first of the two, so a join settles exactly once. */
  onError?: (error: Error) => void;
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
  /**
   * How far through this space's event history the client has read. Outlives
   * the socket, which is what lets a reconnect ask for only what it missed.
   */
  syncCursor: SyncCursor | null;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** Pending idle teardown; see `REALTIME_IDLE_GRACE_MS`. */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** Liveness probe; see `REALTIME_PING_INTERVAL_MS`. */
  pingTimer: ReturnType<typeof setInterval> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
}

export type RealtimeAccessChange = Omit<RealtimeAccessChangedMessage, "type"> & {
  spaceId: string;
};

interface PresenceSubscription<TState = unknown> {
  room: string;
  callback: (event: PresenceMessage<TState>) => void;
}

/**
 * The rejection an aborted upload produces.
 *
 * A cancellation is not a failure: callers tell the two apart with
 * `isUploadAborted` so they can drop their placeholder without reporting an
 * error the user caused on purpose.
 */
function uploadAbortError(): Error {
  const error = new Error("Upload cancelled");
  error.name = "AbortError";
  return error;
}

export function isUploadAborted(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class ApiClient {
  baseUrl: string;
  accessToken?: string;
  socketHost?: string;
  realtimeConnections = new Map<string, RealtimeConnection>();
  private readonly realtimeAccessListeners = new Set<
    (change: RealtimeAccessChange) => void
  >();
  private readonly replica = new ReplicaCache();

  constructor(options: {
    baseUrl?: string;
    accessToken?: string;
    socketHost?: string;
  }) {
    this.baseUrl = options.baseUrl ?? "";
    this.accessToken = options.accessToken;
    this.socketHost = options?.socketHost;

    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.reconnectRealtimeNow());
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") this.reconnectRealtimeNow();
      });
    }
  }

  /**
   * Enable the persistent row cache for the current browser identity.
   * A scope is intentionally required: browser sessions can change users while
   * IndexedDB survives logout, so unscoped API data is never persisted.
   */
  setReplicaScope(scope: string | null | undefined): void {
    this.replica.setScope(scope);
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

  private commentsPath(spaceId: string, documentId: string): string {
    return `/api/v1/spaces/${spaceId}/comments?documentId=${encodeURIComponent(documentId)}`;
  }

  private categorySlugsQuery(categorySlugs: string[]): string {
    return [...new Set(categorySlugs)].sort().join(",");
  }

  /**
   * Apply a mutation to the cache before the request, and undo it if the
   * request fails.
   *
   * `reconcile` runs on success with the server's answer, which is what makes
   * the local guess disposable: it is replaced by the canonical rows rather
   * than trusted.
   */
  private async withOptimisticReplica<TResult>(
    optimistic: () => Promise<(ReplicaOperation | null) | Array<ReplicaOperation | null>>,
    request: () => Promise<TResult>,
    reconcile?: (result: TResult) => Promise<void>,
  ): Promise<TResult> {
    const pending = await optimistic();
    const operations = Array.isArray(pending) ? pending : [pending];

    try {
      const result = await request();
      await reconcile?.(result);
      return result;
    } catch (error) {
      await Promise.all(operations.map((operation) => this.replica.rollback(operation)));
      throw error;
    }
  }

  async apiFetch<T>(
    base: string,
    path: string,
    options?: {
      query?: Record<string, string | number | boolean | undefined | null>;
    } & RequestInit,
  ): Promise<T> {
    const { query, ...fetchOptions } = options || {};
    const finalUrl = this.buildUrl(base, path, query);

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

    const responseText = await response.text();
    return (responseText ? JSON.parse(responseText) : undefined) as T;
  }

  async apiGet<T>(
    base: string,
    path: string,
    query?: Record<string, string | number | boolean | undefined | null>,
  ): Promise<T> {
    return this.apiFetch<T>(base, path, { method: "GET", query });
  }

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
    /** List the members of a space — minimal profiles (id, name, image). */
    get: async (spaceId: string) => {
      return await this.apiGet<User[]>(
        this.baseUrl,
        `/api/v1/users?spaceId=${encodeURIComponent(spaceId)}`,
      );
    },
    getById: async (id: string) => {
      return await this.apiGet<User>(
        this.baseUrl,
        `/api/v1/users?id=${encodeURIComponent(id)}`,
      );
    },
    me: async () => {
      return await this.apiGet<CurrentUser>(this.baseUrl, "/api/v1/users/me");
    },
    /**
     * The register: one page of the accounts on the instance, newest first, which
     * is what the same collection answers unscoped. Admins only — everyone else
     * gets an empty page, which is also why the users tab is not offered to them.
     */
    all: async (query?: { limit?: number; cursor?: string }) => {
      return await this.apiGet<{
        users: InstanceUser[];
        limit: number;
        nextCursor: string | null;
      }>(this.baseUrl, "/api/v1/users", query);
    },
    /**
     * People the caller shares an OAuth group with — invite suggestions.
     * Optionally filtered by a name/email substring. Empty when the caller has
     * no OAuth groups.
     */
    inviteSuggestions: async (query?: string) => {
      const suffix = query ? `?q=${encodeURIComponent(query)}` : "";
      return await this.apiGet<User[]>(
        this.baseUrl,
        `/api/v1/users/suggestions${suffix}`,
      );
    },
  };

  spaces = {
    get: async () => {
      const spaces = await this.apiGet<Space[]>(this.baseUrl, "/api/v1/spaces");
      await this.replica.writeSpaces(spaces);
      return spaces;
    },

    getCached: async () => {
      return await this.replica.readSpaces();
    },

    subscribeCached: (callback: (spaces: Space[] | undefined) => void) => {
      return this.replica.subscribeSpaces(callback);
    },

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
      await this.replica.writeSpace(response.space);
      return response.space;
    },
  };

  space = {
    get: async (spaceId: string) => {
      return await this.apiGet<Space>(this.baseUrl, `/api/v1/spaces/${spaceId}`);
    },

    /** The caller's notification preference for the space, or for one document in it. */
    getNotificationPreference: async (spaceId: string, documentId?: string) => {
      const path = documentId
        ? `/api/v1/spaces/${spaceId}/notification-preference?documentId=${encodeURIComponent(documentId)}`
        : `/api/v1/spaces/${spaceId}/notification-preference`;
      return await this.apiGet<{ muted: boolean }>(this.baseUrl, path);
    },

    /** Mute/unmute the space, or one document in it. */
    setNotificationMuted: async (
      spaceId: string,
      muted: boolean,
      documentId?: string,
    ) => {
      return await this.apiPatch<{ muted: boolean }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/notification-preference`,
        { muted, documentId },
      );
    },

    patch: async (
      spaceId: string,
      body: { name?: string; slug?: string; preferences?: Record<string, string> },
    ) => {
      return await this.withOptimisticReplica(
        () => this.replica.patchSpace(spaceId, body),
        () => this.apiPatch<Space>(this.baseUrl, `/api/v1/spaces/${spaceId}`, body),
        async (space) => await this.replica.writeSpace(space),
      );
    },

    delete: async (spaceId: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}`);
      await this.replica.removeSpace(spaceId);
    },
  };

  spaceMembers = {
    get: async (spaceId: string) => {
      return await this.apiGet<SpaceMember[]>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/members`,
      );
    },
  };

  permissions = {
    /** The current user's role, features and groups in the space. */
    getMe: async (spaceId: string) => {
      return await this.apiGet<{
        role: string | null;
        features: Record<string, boolean>;
        groups: string[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/permissions/me`);
    },

    list: async (
      spaceId: string,
      type?: "role" | "feature" | "all",
      options?: {
        resourceType?: PermissionResourceType;
        resourceId?: string;
        allResources?: boolean;
      },
    ) => {
      const query = new URLSearchParams();
      if (type && type !== "all") query.set("type", type);
      if (options?.resourceType) query.set("resourceType", options.resourceType);
      if (options?.resourceId) query.set("resourceId", options.resourceId);
      if (options?.allResources) query.set("allResources", "true");
      const queryString = query.toString();
      const url = `/api/v1/spaces/${spaceId}/permissions${queryString ? `?${queryString}` : ""}`;
      return await this.apiGet<{ permissions: PermissionEntry[] }>(this.baseUrl, url);
    },

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

    /** Deny a feature. Features only — roles are revoked, not denied. */
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
    get: async (spaceId: string) => {
      const response = await this.apiGet<CategoriesListResponse>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/categories`,
      );
      await this.replica.writeCategories(spaceId, response);
      return response;
    },

    getCached: async (spaceId: string) => {
      return await this.replica.readCategories(spaceId);
    },

    subscribeCached: (
      spaceId: string,
      callback: (response: CategoriesListResponse | undefined) => void,
    ) => {
      return this.replica.subscribeCategories(spaceId, callback);
    },

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
      await this.replica.writeCategory(spaceId, response.category);
      return response.category;
    },

    reorder: async (spaceId: string, categoryIds: string[]) => {
      const response = await this.apiPut<{ success: boolean }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/categories`,
        { categoryIds },
      );
      // The reorder endpoint does not return the canonical list, so re-fetch it
      // rather than treating the local ordering as authoritative.
      if (await this.replica.readCategories(spaceId)) {
        await this.categories.get(spaceId);
      }
      return response.success;
    },
  };

  category = {
    get: async (spaceId: string, id: string) => {
      const response = await this.apiGet<{ category: Category }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/categories/${id}`,
      );
      return response.category;
    },

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
      const response = await this.withOptimisticReplica(
        () => this.replica.patchCategory(spaceId, id, body),
        () =>
          this.apiPut<{ category: Category }>(
            this.baseUrl,
            `/api/v1/spaces/${spaceId}/categories/${id}`,
            body,
          ),
        async (response) => await this.replica.writeCategory(spaceId, response.category),
      );
      return response.category;
    },

    delete: async (spaceId: string, id: string) => {
      await this.withOptimisticReplica(
        () => this.replica.removeCategoryOptimistic(spaceId, id),
        () => this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/categories/${id}`),
        async () => await this.replica.removeCategory(spaceId, id),
      );
    },
  };

  documents = {
    get: async (
      spaceId: string,
      query?: {
        limit?: number;
        cursor?: string;
        type?: string;
        /** Uploaded files, as pseudo-documents, alongside the first page. */
        includeFiles?: boolean;
      } & Record<string, string | number | boolean | undefined>,
    ) => {
      const response = await this.apiGet<{
        documents: DocumentWithProperties[];
        total: number;
        limit: number;
        nextCursor: string | null;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents`, query);

      // Only an unfiltered, exhausted read describes the space's documents.
      // Anything narrower — a cursor page, a parent, a type — contributes rows
      // without being the list, and must not be mistaken for it.
      const isSpaceListing =
        Object.keys(query ?? {}).every((key) => key === "limit") &&
        response.nextCursor === null;

      if (isSpaceListing) {
        await this.replica.writeDocumentList(spaceId, response.documents);
      } else {
        await this.replica.writeDocuments(spaceId, response.documents);
      }
      return response;
    },

    /** The space's documents as the last listing left them. */
    getCached: async (spaceId: string) => {
      return await this.replica.readDocuments(spaceId);
    },

    subscribeCached: (
      spaceId: string,
      callback: (documents: DocumentWithProperties[] | undefined) => void,
    ) => {
      return this.replica.subscribeDocuments(spaceId, callback);
    },

    archived: async (spaceId: string, query?: { limit?: number; cursor?: string }) => {
      const response = await this.apiGet<{
        documents: DocumentWithProperties[];
        limit: number;
        nextCursor: string | null;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents/archived`, query);
      return response;
    },

    /** Documents grouped by category slug, including descendants of each category. */
    getByCategories: async (spaceId: string, categorySlugs: string[]) => {
      const response = await this.apiGet<{
        documentsByCategory: Record<string, DocumentWithProperties[]>;
        categorySlugs: string[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents`, {
        categorySlugs: this.categorySlugsQuery(categorySlugs),
        grouped: true,
      });
      await this.replica.writeDocumentsByCategory(
        spaceId,
        response.documentsByCategory,
        categorySlugs,
      );
      return response.documentsByCategory;
    },

    getByCategoriesCached: async (spaceId: string, categorySlugs: string[]) => {
      return await this.replica.readDocumentsByCategories(spaceId, categorySlugs);
    },

    subscribeByCategoriesCached: (
      spaceId: string,
      categorySlugs: string[],
      callback: (
        documentsByCategory: Record<string, DocumentWithProperties[]> | undefined,
      ) => void,
    ) => {
      return this.replica.subscribeDocumentsByCategories(
        spaceId,
        categorySlugs,
        callback,
      );
    },

    post: async (
      spaceId: string,
      body: {
        slug?: string;
        type?: string;
        content: string;
        readonly?: boolean;
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
      await this.replica.writeDocument(spaceId, response.document);
      return response.document;
    },
  };

  document = {
    get: async (
      spaceId: string,
      documentId: string,
      /** `live` reads the draft as the collaboration room currently holds it. */
      query?: { rev?: number; draft?: boolean; live?: boolean },
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
      await this.replica.writeDocument(spaceId, response.document);
      return response.document;
    },

    getCached: async (spaceId: string, documentIdOrSlug: string) => {
      return await this.replica.readDocument(spaceId, documentIdOrSlug);
    },

    subscribeCached: (
      spaceId: string,
      documentIdOrSlug: string,
      callback: (document: DocumentWithProperties | undefined) => void,
    ) => {
      return this.replica.subscribeDocument(spaceId, documentIdOrSlug, callback);
    },

    put: async (
      spaceId: string,
      documentId: string,
      content: string,
      options?: { publish?: boolean; format?: "html" | "serialized" },
    ) => {
      const detailPath = `/api/v1/spaces/${spaceId}/documents/${documentId}`;
      const requestPath = options?.publish ? `${detailPath}?publish=true` : detailPath;
      const response = await this.withOptimisticReplica(
        () =>
          this.replica.patchDocument(spaceId, documentId, {
            document: (current) => ({
              content,
              // Publishing this edit does not tell us its revision number; keep
              // the last one we know until the response says otherwise.
              ...(options?.publish ? { publishedRev: current.publishedRev ?? 0 } : {}),
            }),
          }),
        async () => {
          const response = await fetch(`${this.baseUrl}${requestPath}`, {
            method: "PUT",
            headers: {
              "Content-Type":
                options?.format === "serialized" ? "application/json" : "text/html",
              ...(this.accessToken
                ? { Authorization: `Bearer ${this.accessToken}` }
                : {}),
            },
            body:
              options?.format === "serialized" ? JSON.stringify({ content }) : content,
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
          // onto the server metadata when refreshing the row.
          await this.replica.writeDocument(spaceId, {
            ...response.document,
            content,
          });
        },
      );
      return { ...response.document, content };
    },

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
      const properties: Record<string, string | string[] | null> = {};
      for (const [key, patch] of Object.entries(body.properties ?? {})) {
        if (patch === null) {
          properties[key] = null;
          continue;
        }
        const value =
          typeof patch === "object" && !Array.isArray(patch) && "value" in patch
            ? patch.value
            : patch;
        properties[key] =
          typeof value === "string" || Array.isArray(value) ? value : String(value);
      }

      return await this.withOptimisticReplica(
        () =>
          this.replica.patchDocument(spaceId, documentId, {
            document: {
              ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
              ...(body.publishedRev !== undefined
                ? { publishedRev: body.publishedRev }
                : {}),
              ...(body.readonly !== undefined ? { readonly: body.readonly } : {}),
            },
            properties,
          }),
        () =>
          this.apiPatch<{ success?: boolean; slug?: string }>(
            this.baseUrl,
            `/api/v1/spaces/${spaceId}/documents/${documentId}`,
            body,
          ),
        async () => {
          // PATCH returns only acknowledgement metadata. Fetch the server's full
          // representation so it replaces the optimistic document exactly.
          await this.document.get(spaceId, documentId).catch(() => undefined);
        },
      );
    },

    /** Content as a JSON body, for code and workflow documents. */
    putCode: async (
      spaceId: string,
      documentId: string,
      content: string,
    ): Promise<void> => {
      await this.withOptimisticReplica(
        () => this.replica.patchDocument(spaceId, documentId, { document: { content } }),
        () =>
          this.apiPut<unknown>(
            this.baseUrl,
            `/api/v1/spaces/${spaceId}/documents/${documentId}`,
            { content },
          ),
        async () => {
          await this.document.get(spaceId, documentId).catch(() => undefined);
        },
      );
    },

    archive: async (spaceId: string, documentId: string) => {
      await this.withOptimisticReplica(
        () => this.replica.archiveDocumentOptimistic(spaceId, documentId),
        () =>
          this.apiDelete(
            this.baseUrl,
            `/api/v1/spaces/${spaceId}/documents/${documentId}`,
          ),
        async () => await this.replica.archiveDocument(spaceId, documentId),
      );
    },

    /** Delete permanently. `archive` is the recoverable version. */
    delete: async (spaceId: string, documentId: string) => {
      await this.withOptimisticReplica(
        () => this.replica.removeDocumentOptimistic(spaceId, documentId),
        () =>
          this.apiDelete(
            this.baseUrl,
            `/api/v1/spaces/${spaceId}/documents/${documentId}?permanent=true`,
          ),
        async () => await this.replica.removeDocument(spaceId, documentId),
      );
    },

    restore: async (spaceId: string, documentId: string) => {
      const response = await this.apiPut<{ success: boolean }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}`,
        { restore: true },
      );
      // Restoring puts the document back into every listing it belongs to,
      // which only the server can work out.
      await this.document.get(spaceId, documentId).catch(() => undefined);
      return response;
    },

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

  documentAccess = {
    /** Everyone who can reach the document, however they reach it. */
    get: async (spaceId: string, documentId: string) => {
      const response = await this.apiGet<{ access: DocumentAccessEntry[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/access`,
      );
      return response.access;
    },
  };

  documentContributors = {
    get: async (spaceId: string, documentId: string) => {
      const response = await this.apiGet<{ contributors: DocumentContributor[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/contributors`,
      );
      return response.contributors;
    },
  };

  documentChildren = {
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
     * `q` may be empty when `filters` alone narrows the result. `filters` is a
     * JSON-encoded `PropertyFilter[]`.
     */
    get: async (
      spaceId: string,
      query: { q?: string; limit?: number; cursor?: string; filters?: string },
    ) => {
      const response = await this.apiGet<{
        results: SearchResult[];
        nextCursor: string | null;
        query: string;
        limit: number;
        filters?: PropertyFilter[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/search`, query);
      return response;
    },

    /**
     * The strongest matches in the user's other spaces. `q` is required here —
     * filters alone give a foreign document nothing to be ranked by.
     */
    otherSpaces: async (query: {
      q: string;
      excludeSpaceId?: string;
      filters?: string;
    }) => {
      const response = await this.apiGet<{
        results: CrossSpaceSearchResult[];
        query: string;
      }>(this.baseUrl, "/api/v1/search", query);
      return response.results;
    },

    rebuild: async (spaceId: string) => {
      await this.apiPost(this.baseUrl, `/api/v1/spaces/${spaceId}/search/rebuild`, {});
    },
  };

  properties = {
    get: async (spaceId: string) => {
      const response = await this.apiGet<{ properties: PropertyInfo[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/properties`,
      );
      return response.properties;
    },
  };

  auditLogs = {
    /** Audit logs for a space, or for one document in it. */
    get: async (
      spaceId: string,
      query?: { documentId?: string; limit?: number; cursor?: string },
    ) => {
      return this.apiGet<{
        auditLogs: AuditLog[];
        limit: number;
        nextCursor: string | null;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/audit-logs`, query);
    },
  };

  /** Reading a repository document: what the browser renders. */
  git = {
    overview: (spaceId: string, documentId: string) =>
      this.apiGet<{
        empty: boolean;
        branch: string;
        branches: string[];
        head: GitCommit | null;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/documents/${documentId}/git`, {
        view: "overview",
      }),

    tree: (spaceId: string, documentId: string, rev: string, path: string) =>
      this.apiGet<{ entries: GitTreeEntry[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/git`,
        { view: "tree", rev, path },
      ),

    blob: (spaceId: string, documentId: string, rev: string, path: string) =>
      this.apiGet<{ text: string | null; size: number }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/git`,
        { view: "blob", rev, path },
      ),

    log: (spaceId: string, documentId: string, rev: string, limit = 30) =>
      this.apiGet<{ commits: GitCommit[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/documents/${documentId}/git`,
        { view: "log", rev, limit },
      ),
  };

  uploads = {
    get: async (spaceId: string) => {
      const result = await this.apiGet<{
        files: { key: string; url: string; size: number; updatedAt: string }[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/uploads`);
      return result.files;
    },

    post: async (
      spaceId: string,
      file: File | Blob,
      filename?: string,
      documentId?: string,
      options?: { onProgress?: (progress: number) => void; signal?: AbortSignal },
    ) => {
      const name = filename ?? (file instanceof File ? file.name : null);
      const query = new URLSearchParams();
      if (name) {
        query.set("filename", name);
      }
      if (documentId) {
        query.set("documentId", documentId);
      }
      const path = `/api/v1/spaces/${spaceId}/uploads?${query}`;

      // Use XMLHttpRequest instead of fetch so we can report upload progress.
      // fetch has no way to observe how much of the request body has been sent.
      return await new Promise<{ url: string; [key: string]: unknown }>(
        (resolve, reject) => {
          const signal = options?.signal;
          if (signal?.aborted) {
            reject(uploadAbortError());
            return;
          }

          const xhr = new XMLHttpRequest();
          xhr.open("POST", path);

          if (signal) {
            const abort = () => xhr.abort();
            signal.addEventListener("abort", abort, { once: true });
            // Both terminal events fire after `abort()` too, so the listener is
            // dropped from either — an aborted signal outlives this request.
            xhr.addEventListener("loadend", () =>
              signal.removeEventListener("abort", abort),
            );
            xhr.addEventListener("abort", () => reject(uploadAbortError()));
          }

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

          // The file is the body itself, so the request streams instead of
          // being assembled as a multipart document in memory first.
          xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
          xhr.send(file);
        },
      );
    },
  };

  upload = {
    get: async (spaceId: string, filename: string) => {
      const response = await this.apiGet<{ url: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/uploads/${filename}`,
      );
      return response.url;
    },

    delete: async (spaceId: string, filename: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/uploads/${filename}`);
    },
  };

  accessTokens = {
    get: async (spaceId: string) => {
      return await this.apiGet<{ tokens: AccessToken[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens`,
      );
    },

    getById: async (spaceId: string, tokenId: string) => {
      return await this.apiGet<{ token: AccessToken }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens/${tokenId}`,
      );
    },

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

    revoke: async (spaceId: string, tokenId: string) => {
      return await this.apiPatch<{ message: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens/${tokenId}`,
        {},
      );
    },

    delete: async (spaceId: string, tokenId: string) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/access-tokens/${tokenId}`,
      );
    },
  };

  /**
   * The caller's own tokens, the kind `vektor login` mints. Separate from
   * `accessTokens`: those are the space's, listed and minted by its owners.
   */
  personalAccessTokens = {
    get: async () => {
      return await this.apiGet<{ tokens: PersonalAccessToken[] }>(
        this.baseUrl,
        "/api/v1/access-tokens",
      );
    },

    /** The token carries the caller's own role on the space; there is nothing to pick. */
    create: async (body: {
      name: string;
      spaceId: string;
      expiresInDays?: number | null;
    }) => {
      return await this.apiPost<{
        id: string;
        token: string;
        spaceId: string;
        permission: string;
        message: string;
      }>(this.baseUrl, "/api/v1/access-tokens", body);
    },

    revoke: async (tokenId: string) => {
      return await this.apiPatch<{ message: string }>(
        this.baseUrl,
        `/api/v1/access-tokens/${tokenId}`,
        {},
      );
    },

    delete: async (tokenId: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/access-tokens/${tokenId}`);
    },
  };

  shares = {
    get: async (spaceId: string, documentId?: string) => {
      return await this.apiGet<{ links: ShareLink[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/shares${documentId ? `?documentId=${encodeURIComponent(documentId)}` : ""}`,
      );
    },

    create: async (
      spaceId: string,
      body: {
        name: string;
        resourceType: string;
        resourceId: string;
        expiresInDays: number;
        password?: string;
      },
    ) => {
      return await this.apiPost<{ id: string; path: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/shares`,
        body,
      );
    },

    revoke: async (spaceId: string, linkId: string) => {
      await this.apiDelete(this.baseUrl, `/api/v1/spaces/${spaceId}/shares/${linkId}`);
    },
  };

  secrets = {
    /** List secrets. Owner only. */
    get: async (spaceId: string) => {
      return await this.apiGet<{ secrets: SpaceSecret[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/secrets`,
      );
    },

    getByName: async (spaceId: string, name: string) => {
      return await this.apiGet<{ name: string; value: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/secrets/${encodeURIComponent(name)}`,
      );
    },

    /** Create a secret, or overwrite one that already has this name. */
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
    /** OAuth integrations for the current user, not for the space as a whole. */
    get: async (spaceId: string) => {
      return await this.apiGet<{ connections: OAuthIntegrationConnection[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/integrations`,
      );
    },

    getByProvider: async (spaceId: string, provider: OAuthIntegrationProvider) => {
      return await this.apiGet<{ connection: OAuthIntegrationConnection }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/integrations/${provider}`,
      );
    },

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

    disconnect: async (spaceId: string, provider: OAuthIntegrationProvider) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/integrations/${provider}`,
      );
    },
  };

  extensions = {
    get: async (
      spaceId: string,
    ): Promise<{ extensions: ExtensionInfo[]; errors: ExtensionManifestError[] }> => {
      const response = await this.apiGet<{
        extensions: ExtensionInfo[];
        errors?: ExtensionManifestError[];
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/extensions`);

      const manifest = {
        extensions: response.extensions ?? [],
        errors: response.errors ?? [],
      };
      await this.replica.writeExtensions(spaceId, manifest);
      return manifest;
    },

    getCached: async (
      spaceId: string,
    ): Promise<
      { extensions: ExtensionInfo[]; errors: ExtensionManifestError[] } | undefined
    > => {
      return await this.replica.readExtensions(spaceId);
    },

    subscribeCached: (
      spaceId: string,
      callback: (
        response:
          | { extensions: ExtensionInfo[]; errors: ExtensionManifestError[] }
          | undefined,
      ) => void,
    ) => {
      return this.replica.subscribeExtensions(spaceId, callback);
    },

    getById: async (spaceId: string, extensionId: string): Promise<ExtensionInfo> => {
      return await this.apiGet<ExtensionInfo>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/extensions/${extensionId}`,
      );
    },

    /** Enable or disable an extension. */
    update: async (
      spaceId: string,
      extensionId: string,
      body: { enabled: boolean },
    ): Promise<ExtensionInfo> => {
      const extension = await this.apiPatch<ExtensionInfo>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/extensions/${extensionId}`,
        body,
      );
      await this.replica.writeExtension(spaceId, extension);
      return extension;
    },

    /** Upload an extension as a zip. */
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

      const extension = (await response.json()) as ExtensionInfo;
      await this.replica.writeExtension(spaceId, extension);
      return extension;
    },

    delete: async (spaceId: string, extensionId: string) => {
      await this.apiDelete(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/extensions/${extensionId}`,
      );
      await this.replica.removeExtension(spaceId, extensionId);
    },

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

  comments = {
    get: async (spaceId: string, documentId: string) => {
      const response = await this.apiGet<{ comments: Comment[] }>(
        this.baseUrl,
        this.commentsPath(spaceId, documentId),
      );
      await this.replica.writeComments(spaceId, documentId, response.comments);
      return response.comments;
    },

    getCached: async (spaceId: string, documentId: string) => {
      return await this.replica.readComments(spaceId, documentId);
    },

    subscribeCached: (
      spaceId: string,
      documentId: string,
      callback: (comments: Comment[] | undefined) => void,
    ) => {
      return this.replica.subscribeComments(spaceId, documentId, callback);
    },

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
      const optimisticId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `optimistic-${crypto.randomUUID()}`
          : `optimistic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const now = new Date().toISOString();
      const optimisticComment: Comment = {
        id: optimisticId,
        resourceType: "document",
        resourceId: documentId,
        content: body.content,
        reference: body.reference,
        parentId: body.parentId,
        type: body.type,
        createdAt: now,
        createdBy: "",
        updatedAt: now,
      };
      const response = await this.withOptimisticReplica(
        () => this.replica.addComment(spaceId, documentId, optimisticComment),
        () =>
          this.apiPost<{ comment: Comment }>(
            this.baseUrl,
            `/api/v1/spaces/${spaceId}/comments`,
            { ...body, documentId },
          ),
        async (response) =>
          await this.replica.replaceComment(
            spaceId,
            documentId,
            optimisticId,
            response.comment,
          ),
      );
      return response.comment;
    },

    /** Re-anchor one or more comments onto a new document reference. */
    patch: async (
      spaceId: string,
      documentId: string,
      body: {
        commentIds: string[];
        reference: string;
      },
    ) => {
      await this.withOptimisticReplica(
        () =>
          this.replica.patchComments(spaceId, body.commentIds, {
            reference: body.reference,
          }),
        () =>
          this.apiPatch<{ success: boolean }>(
            this.baseUrl,
            `/api/v1/spaces/${spaceId}/comments`,
            { ...body, documentId },
          ),
        async () => {
          await this.comments.get(spaceId, documentId).catch(() => undefined);
        },
      );
    },

    /** Resolve a thread: archives every comment sharing the reference. */
    resolve: async (spaceId: string, documentId: string, commentIds: string[]) => {
      await this.withOptimisticReplica(
        // A resolved thread is archived, and the endpoint stops listing it.
        () => this.replica.removeCommentsOptimistic(spaceId, documentId, commentIds),
        () =>
          this.apiPatch<{ success: boolean }>(
            this.baseUrl,
            `/api/v1/spaces/${spaceId}/comments`,
            { commentIds, archived: true, documentId },
          ),
        async () => {
          await this.comments.get(spaceId, documentId).catch(() => undefined);
        },
      );
    },

    delete: async (spaceId: string, documentId: string, commentId: string) => {
      await this.withOptimisticReplica(
        () => this.replica.removeCommentsOptimistic(spaceId, documentId, [commentId]),
        () =>
          this.apiFetch<void>(this.baseUrl, `/api/v1/spaces/${spaceId}/comments`, {
            method: "DELETE",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ commentId, documentId }),
          }),
        async () => await this.replica.removeComments(spaceId, documentId, [commentId]),
      );
    },
  };

  workflows = {
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

    /** Latest run for a workflow document, or null if it has never run. */
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

    /**
     * Retry a terminal run, resuming from its cached step results. Starts a new
     * run for the same document + inputs; steps that already succeeded replay
     * from cache and only failed/changed steps re-execute.
     */
    retryRun: async (spaceId: string, runId: string): Promise<{ runId: string }> => {
      return await this.apiPost<{ runId: string }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/runs`,
        { resumeFromRunId: runId },
      );
    },

    listRuns: async (
      spaceId: string,
      query?: {
        sourceExtensionId?: string;
        filterDocumentId?: string;
        limit?: number;
        cursor?: string;
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
        limit: number;
        nextCursor: string | null;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/workflows/runs`, query);
      return response;
    },

    listSchedules: async (spaceId: string) => {
      return await this.apiGet<{ schedules: WorkflowSchedule[] }>(
        this.baseUrl,
        `/api/v1/spaces/${spaceId}/workflows/schedules`,
      );
    },

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

    /** Delete a schedule. Its run history is kept. */
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

    /** Job execution history, newest first. */
    listRuns: async (
      spaceId: string,
      options?: { jobId?: string; scheduleId?: string; limit?: number; cursor?: string },
    ) => {
      return this.apiGet<{
        runs: JobRun[];
        limit: number;
        nextCursor: string | null;
      }>(this.baseUrl, `/api/v1/spaces/${spaceId}/jobs/runs`, options);
    },
  };

  aiChatSessions = {
    list: async (spaceId: string): Promise<AIChatSessionListEntry[]> => {
      const { sessions } = await this.apiFetch<{ sessions: AIChatSessionListEntry[] }>(
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
      // A subscriber is arriving, so the connection is no longer idle. Every
      // subscribe path comes through here, which is what makes this the one
      // place a pending teardown has to be called off.
      if (existingConnection.idleTimer !== null) {
        clearTimeout(existingConnection.idleTimer);
        existingConnection.idleTimer = null;
      }
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
      syncCursor: null,
      reconnectAttempts: 0,
      reconnectTimer: null,
      idleTimer: null,
      pingTimer: null,
      pongTimer: null,
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
      setTimeout(() => {
        if (connection.socket === socket) connection.reconnectAttempts = 0;
      }, RECONNECT_SETTLED_MS);
      // No blanket resync on reconnect: the `Subscribe` replayed below carries
      // the cursor, and the server answers with what actually changed.
      this.resyncRealtimeConnection(connection);
      this.startRealtimeHeartbeat(connection);
    });

    socket.addEventListener("message", (event) => {
      if (connection.socket !== socket) return;
      this.handleRealtimeMessage(connection, event);
    });

    const onClose = (event: Event) => {
      if (connection.socket !== socket) return; // a newer socket already took over
      this.handleRealtimeClose(connection, (event as CloseEvent).code);
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

    if (type === WsMsgType.Pong) {
      this.clearRealtimePongTimeout(connection);
      return;
    }

    // A refused or failed frame is answered with this and nothing else, so
    // dropping it left the failure — a rejected Yjs join above all — as silence.
    if (type === WsMsgType.Error) {
      const detail = wsDecodeJson<RealtimeErrorPayload>(payload);
      console.error("Realtime error frame", { spaceId: connection.spaceId, detail });
      if (detail.documentId) {
        this.failYjsRoomJoins(connection, detail.documentId, detail.message);
      }
      return;
    }

    if (type === WsMsgType.AccessChanged) {
      const change = wsDecodeJson<Omit<RealtimeAccessChangedMessage, "type">>(payload);
      for (const listener of this.realtimeAccessListeners) {
        listener({ spaceId: connection.spaceId, ...change });
      }
      return;
    }

    if (type === WsMsgType.Event) {
      const msg = wsDecodeJson<Omit<RealtimeEventMessage, "type">>(payload);

      // Advanced on a resync too, or every later reconnect would resync again.
      // Only ever forwards: a catch-up answer computed before a live event can
      // arrive after it.
      if (msg.epoch !== undefined && msg.seq !== undefined) {
        const held = connection.syncCursor;
        if (!held || held.epoch !== msg.epoch || msg.seq > held.seq) {
          connection.syncCursor = { epoch: msg.epoch, seq: msg.seq };
        }
      }

      if (msg.resync) {
        this.notifyRealtimeResync(connection);
        return;
      }

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
          if (entry.onSynced && entry.onReset && sharesNoHistory(entry.ydoc, update)) {
            const onReset = entry.onReset;
            entry.onSynced = undefined;
            entry.onError = undefined;
            entry.onReset = undefined;
            onReset();
            continue;
          }
          applyUpdate(entry.ydoc, update, "remote");
          const onSynced = entry.onSynced;
          entry.onSynced = undefined;
          entry.onError = undefined;
          onSynced?.();
        }
      }
      return;
    }

    if (type === WsMsgType.YjsSyncRequest) {
      const { documentId, update: serverStateVector } = wsDecodeYjsUpdate(payload);
      const ydocs = connection.yjsRooms.get(documentId);
      for (const entry of ydocs ?? []) {
        const missing = encodeStateAsUpdate(entry.ydoc, serverStateVector);
        if (missing.length > 2) {
          this.sendRealtimeEphemeral(connection, wsEncodeYjsUpdate(documentId, missing));
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

  /**
   * Refetch everything, for when the server cannot say what was missed. Per
   * subscription, whose topics are narrower than the connection's.
   */
  private notifyRealtimeResync(connection: RealtimeConnection): void {
    for (const subscription of connection.subscriptions) {
      const topics = [...subscription.topics];
      if (topics.length === 0) continue;
      subscription.callback({
        type: "event",
        resync: true,
        topics,
        events: topics.map((topic) => ({ topic })),
        timestamp: new Date().toISOString(),
      });
    }
  }

  private pingRealtimeConnection(connection: RealtimeConnection): void {
    if (connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.pongTimer !== null) return;

    connection.socket.send(wsEncode(WsMsgType.Ping, {}));
    connection.pongTimer = setTimeout(() => {
      connection.pongTimer = null;
      // Unanswered: the socket is dead but still reports OPEN, so nothing else
      // will ever close it. Closing it here runs the reconnect path.
      try {
        connection.socket.close();
      } catch {
        // already closing — the close handler still runs
      }
      this.handleRealtimeClose(connection);
    }, REALTIME_PONG_TIMEOUT_MS);
  }

  private startRealtimeHeartbeat(connection: RealtimeConnection): void {
    this.stopRealtimeHeartbeat(connection);
    connection.pingTimer = setInterval(
      () => this.pingRealtimeConnection(connection),
      REALTIME_PING_INTERVAL_MS,
    );
  }

  private clearRealtimePongTimeout(connection: RealtimeConnection): void {
    if (connection.pongTimer === null) return;
    clearTimeout(connection.pongTimer);
    connection.pongTimer = null;
  }

  private stopRealtimeHeartbeat(connection: RealtimeConnection): void {
    if (connection.pingTimer !== null) {
      clearInterval(connection.pingTimer);
      connection.pingTimer = null;
    }
    this.clearRealtimePongTimeout(connection);
  }

  /**
   * Called when the device comes back: the browser knows the network returned
   * long before the next backoff attempt is due, and a socket that died while
   * the tab was hidden is worth probing rather than trusting for another cycle.
   */
  private reconnectRealtimeNow(): void {
    for (const connection of this.realtimeConnections.values()) {
      if (connection.closed) continue;

      if (connection.socket.readyState === WebSocket.OPEN) {
        this.pingRealtimeConnection(connection);
        continue;
      }

      if (connection.reconnectTimer === null) continue;
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
      connection.reconnectAttempts = 0;
      this.openRealtimeSocket(connection);
    }
  }

  private handleRealtimeClose(connection: RealtimeConnection, code?: number): void {
    this.stopRealtimeHeartbeat(connection);
    if (connection.closed) return;

    // A later subscription creates a fresh connection and authorization attempt.
    if (code === WS_CLOSE_FORBIDDEN) {
      this.teardownRealtimeConnection(connection);
      return;
    }

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
      socket.send(this.subscribeFrame(connection, topics));
    }

    for (const [documentId, entries] of connection.yjsRooms) {
      socket.send(wsEncode(WsMsgType.YjsJoin, this.yjsJoinPayload(documentId, entries)));
    }

    for (const payload of connection.presenceJoinPayloads.values()) {
      socket.send(wsEncode(WsMsgType.PresenceJoin, payload));
    }
  }

  /** Permanently close a connection and stop any pending reconnect. */
  private teardownRealtimeConnection(connection: RealtimeConnection): void {
    connection.closed = true;
    this.stopRealtimeHeartbeat(connection);
    if (connection.reconnectTimer !== null) {
      clearTimeout(connection.reconnectTimer);
      connection.reconnectTimer = null;
    }
    if (connection.idleTimer !== null) {
      clearTimeout(connection.idleTimer);
      connection.idleTimer = null;
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

  private isRealtimeConnectionIdle(connection: RealtimeConnection): boolean {
    return (
      connection.subscriptions.size === 0 &&
      connection.presenceSubscriptions.size === 0 &&
      connection.yjsRooms.size === 0
    );
  }

  /**
   * Tear down the connection once nothing is subscribed to it anymore — after a
   * grace period, not immediately.
   *
   * Subscribers are Solid effects, and an effect that re-runs unsubscribes
   * before it subscribes again. When the last one does that — `useSync` on a
   * space-id change, a route swap unmounting the only subscriber a tick before
   * the next view mounts one — an immediate teardown closed the socket and the
   * resubscribe opened a fresh one, which then has to replay every
   * subscription. Booting a space home did exactly this: connect, close,
   * reconnect, before a single event had arrived.
   *
   * Deferring costs an idle socket for the grace period; closing early costs a
   * reconnect *and* the events that fall in the gap.
   */
  private maybeCloseRealtimeConnection(connection: RealtimeConnection): void {
    if (!this.isRealtimeConnectionIdle(connection)) return;
    if (connection.idleTimer !== null) return;

    connection.idleTimer = setTimeout(() => {
      connection.idleTimer = null;
      if (!this.isRealtimeConnectionIdle(connection)) return;
      this.teardownRealtimeConnection(connection);
    }, REALTIME_IDLE_GRACE_MS);
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

  /**
   * A `Subscribe` frame carrying the connection's cursor. Every subscribe sends
   * it, not just the one after a reconnect, so an incremental one cannot
   * advance the position past envelopes the client has yet to hear about.
   */
  private subscribeFrame(
    connection: RealtimeConnection,
    topics: RealtimeTopic[],
  ): Uint8Array<ArrayBuffer> {
    return wsEncode(WsMsgType.Subscribe, {
      topics,
      ...(connection.syncCursor ? { cursor: connection.syncCursor } : {}),
    });
  }

  private sendRealtimeMessage(
    connection: RealtimeConnection,
    type: typeof WsMsgType.Subscribe | typeof WsMsgType.Unsubscribe,
    topics: RealtimeTopic[],
  ) {
    if (topics.length === 0) return;
    this.sendRealtimeState(
      connection,
      type === WsMsgType.Subscribe
        ? this.subscribeFrame(connection, topics)
        : wsEncode(type, { topics }),
    );
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

  private yjsJoinPayload(
    documentId: string,
    entries: Iterable<YjsRoomEntry>,
  ): { documentId: string; stateVector?: string } {
    const first = entries[Symbol.iterator]().next();
    if (first.done) return { documentId };
    const vector = encodeStateVector(first.value.ydoc);
    if (vector.length <= 1) return { documentId };
    let binary = "";
    for (const byte of vector) binary += String.fromCharCode(byte);
    return { documentId, stateVector: btoa(binary) };
  }

  /**
   * Fails the joins still waiting on the room the server refused. Cleared like
   * `onSynced`, so a frame for a room that already synced reaches nobody: losing
   * access to a joined room is announced by `AccessChanged`, not by this.
   */
  private failYjsRoomJoins(
    connection: RealtimeConnection,
    documentId: string,
    message: string | undefined,
  ): void {
    const entries = connection.yjsRooms.get(documentId);
    if (!entries) return;
    for (const entry of entries) {
      const onError = entry.onError;
      entry.onSynced = undefined;
      entry.onError = undefined;
      onError?.(new Error(message || "The server refused the document"));
    }
  }

  /**
   * Whether the space's realtime socket is up right now. Callers waiting on a
   * reply time themselves out, and a reconnect backoff runs up to 30s, which
   * would otherwise be indistinguishable from a server that never answered.
   */
  isRealtimeConnected(spaceId: string): boolean {
    const connection = this.realtimeConnections.get(spaceId);
    if (!connection || connection.closed) return false;
    return connection.socket?.readyState === WebSocket.OPEN;
  }

  subscribeToRealtimeAccessChanges(
    listener: (change: RealtimeAccessChange) => void,
  ): () => void {
    this.realtimeAccessListeners.add(listener);
    return () => this.realtimeAccessListeners.delete(listener);
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
    onError?: (error: Error) => void,
    onReset?: () => void,
  ): () => void {
    if (!(ydoc instanceof YDoc)) {
      console.warn("Ignoring Yjs room join without a Y.Doc", { documentId, spaceId });
      return () => {};
    }

    const connection = this.getRealtimeConnection(spaceId);

    let ydocs = connection.yjsRooms.get(documentId);
    const entry: YjsRoomEntry = { ydoc, onSynced, onError, onReset };
    if (!ydocs) {
      ydocs = new Set();
      connection.yjsRooms.set(documentId, ydocs);
      ydocs.add(entry);
      // First doc for this room — announce the join (replayed on reconnect).
      this.sendRealtimeState(
        connection,
        wsEncode(WsMsgType.YjsJoin, this.yjsJoinPayload(documentId, ydocs)),
      );
    } else {
      const source = ydocs.values().next().value;
      if (source) {
        applyUpdate(ydoc, encodeStateAsUpdate(source.ydoc), "remote");
        queueMicrotask(() => {
          entry.onSynced = undefined;
          entry.onError = undefined;
          entry.onReset = undefined;
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
