/**
 * The subscription half of one realtime connection: the topics it listens on,
 * and the space events fanned back out to it.
 */

import type { WebSocket } from "ws";
import { isAccessDenied, verifyAccess } from "#acl/guards.ts";
import { Permission, ResourceType } from "#acl/permissions.ts";
import { appLogger } from "#observability/logger.ts";
import {
  catchUpSince,
  headSyncSeq,
  type SyncCatchUp,
  syncEpoch,
} from "./changeLog.ts";
import { type RealtimeEventEnvelope, subscribeToSyncEvents } from "./events.ts";
import {
  isDocumentRealtimeTopic,
  isWorkflowRunRealtimeTopic,
  type RealtimeSubscribePayload,
  realtimeTopics,
  type SyncCursor,
  WsMsgType,
  wsDecodeJson,
  wsEncode,
} from "./protocol.ts";

/**
 * Topics carrying data from anywhere in the space, so no per-resource check
 * could scope them to a document-level grantee: they stay on a space role.
 */
const realtimeSpaceTopics = new Set<string>([
  realtimeTopics.acl,
  realtimeTopics.categories,
  realtimeTopics.categoryDocuments,
  realtimeTopics.documentTree,
  realtimeTopics.documents,
  realtimeTopics.extensions,
  realtimeTopics.properties,
  realtimeTopics.workflowRuns,
]);

type TopicAccess = "allowed" | "denied" | "unknown";

/** Tracks the topic subscriptions belonging to one realtime connection. */
export class TopicSubscriptions {
  private readonly topics = new Set<string>();
  private readonly off: () => void;

  constructor(
    private readonly spaceId: string,
    private readonly userId: string,
    private readonly websocket: WebSocket,
  ) {
    this.off = subscribeToSyncEvents((event) => this.forward(event));
  }

  /** Handles a subscription frame and returns whether the frame was recognized. */
  async handle(type: WsMsgType, payload: Uint8Array): Promise<boolean> {
    if (type !== WsMsgType.Subscribe && type !== WsMsgType.Unsubscribe) {
      return false;
    }

    const { topics, cursor } = wsDecodeJson<RealtimeSubscribePayload>(payload);

    // Dropping a subscription can leak nothing, so it is never authorized: a
    // caller whose role was revoked mid-connection has to stay able to stop the
    // feed, and the fan-out does not re-verify what it already holds.
    if (type === WsMsgType.Unsubscribe) {
      for (const topic of topics) this.topics.delete(topic);
      return true;
    }

    const hasSpaceRole = this.spaceRoleResolver();
    const authorized = new Set<string>();
    for (const topic of topics) {
      if ((await this.authorize(topic, hasSpaceRole)) === "allowed") {
        authorized.add(topic);
      }
    }

    if (authorized.size !== topics.length) {
      this.websocket.send(
        wsEncode(WsMsgType.Error, {
          message: "One or more realtime topics are forbidden",
        }),
      );
    }

    for (const topic of authorized) this.topics.add(topic);
    this.answerCursor(cursor);
    return true;
  }

  /**
   * Tell a subscribing client what changed while it was away, or that the
   * history no longer reaches its cursor and it has to refetch. A client with
   * no cursor yet is given the current head, so its next reconnect has a
   * position to catch up from.
   */
  private answerCursor(cursor: SyncCursor | undefined): void {
    const catchUp: SyncCatchUp = cursor
      ? catchUpSince(this.spaceId, cursor, (topic) => this.topics.has(topic))
      : { kind: "events", seq: headSyncSeq(this.spaceId), events: [] };
    const timestamp = new Date().toISOString();

    if (catchUp.kind === "resync") {
      // No topics: the client synthesises one event per subscription from the
      // topics it holds, which is narrower than anything this side knows. The
      // head travels with it so the client does not keep the dead position.
      this.websocket.send(
        wsEncode(WsMsgType.Event, {
          resync: true,
          topics: [],
          events: [],
          timestamp,
          seq: headSyncSeq(this.spaceId),
          epoch: syncEpoch,
        }),
      );
      return;
    }

    // Sent even when nothing matched: the cursor still has to advance past
    // envelopes this connection had no interest in.
    this.websocket.send(
      wsEncode(WsMsgType.Event, {
        topics: catchUp.events.map(({ topic }) => topic),
        events: catchUp.events,
        timestamp,
        seq: catchUp.seq,
        epoch: syncEpoch,
      }),
    );
  }

  close(): void {
    this.off();
  }

  async revalidate(): Promise<void> {
    const hasSpaceRole = this.spaceRoleResolver();
    for (const topic of [...this.topics]) {
      if ((await this.authorize(topic, hasSpaceRole)) !== "denied") continue;
      this.topics.delete(topic);
      appLogger.info("Dropped a realtime subscription that lost its access", {
        spaceId: this.spaceId,
        topic,
      });
    }
  }

  private forward(event: RealtimeEventEnvelope): void {
    if (event.spaceId !== this.spaceId) return;

    const matchedEvents = event.events.filter(({ topic }) => this.topics.has(topic));
    if (matchedEvents.length === 0) return;

    this.websocket.send(
      wsEncode(WsMsgType.Event, {
        topics: matchedEvents.map(({ topic }) => topic),
        events: matchedEvents,
        timestamp: event.timestamp,
        seq: event.seq,
        epoch: event.epoch,
      }),
    );
  }

  /**
   * Whether this connection may subscribe to `topic`. The connection grants
   * nothing on its own, so every topic is authorized against the resource it
   * describes.
   */
  private async authorize(
    topic: string,
    hasSpaceRole: () => Promise<TopicAccess>,
  ): Promise<TopicAccess> {
    if (realtimeSpaceTopics.has(topic)) {
      return await hasSpaceRole();
    }

    if (isDocumentRealtimeTopic(topic)) {
      try {
        await verifyAccess(
          this.spaceId,
          { type: ResourceType.DOCUMENT, id: topic.slice("document:".length) },
          this.userId,
          Permission.VIEWER,
        );
      } catch (error) {
        return isAccessDenied(error) ? "denied" : "unknown";
      }
      return "allowed";
    }

    // Pure change signals — the run data is fetched via ACL-checked endpoints —
    // but which runs exist is space-wide information.
    if (isWorkflowRunRealtimeTopic(topic)) {
      return await hasSpaceRole();
    }

    return "denied";
  }

  /**
   * A space-viewer verdict for one frame, computed at most once so a frame
   * naming several space topics costs a single lookup. Deliberately not cached
   * on the connection, so a revoked role stops authorizing subscriptions.
   */
  private spaceRoleResolver(): () => Promise<TopicAccess> {
    let verdict: Promise<TopicAccess> | undefined;
    return () => {
      verdict ??= verifyAccess(
        this.spaceId,
        { type: ResourceType.SPACE, id: this.spaceId },
        this.userId,
        Permission.VIEWER,
      ).then(
        () => "allowed",
        (error) => (isAccessDenied(error) ? "denied" : "unknown"),
      );
      return verdict;
    };
  }
}
