/**
 * The subscription half of one realtime connection: the topics it listens on,
 * and the space events fanned back out to it.
 */

import type { WebSocket } from "ws";
import { verifyDocumentRole, verifySpaceRole } from "#acl/guards.ts";
import { Permission } from "#acl/permissions.ts";
import { type RealtimeEventEnvelope, subscribeToSyncEvents } from "./events.ts";
import {
  isDocumentRealtimeTopic,
  isWorkflowRunRealtimeTopic,
  realtimeTopics,
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

    const { topics } = wsDecodeJson<{ topics: string[] }>(payload);

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
      if (await this.authorize(topic, hasSpaceRole)) authorized.add(topic);
    }

    if (authorized.size !== topics.length) {
      this.websocket.send(
        wsEncode(WsMsgType.Error, {
          message: "One or more realtime topics are forbidden",
        }),
      );
    }

    for (const topic of authorized) this.topics.add(topic);
    return true;
  }

  close(): void {
    this.off();
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
    hasSpaceRole: () => Promise<boolean>,
  ): Promise<boolean> {
    if (realtimeSpaceTopics.has(topic)) {
      return await hasSpaceRole();
    }

    if (isDocumentRealtimeTopic(topic)) {
      try {
        await verifyDocumentRole(
          this.spaceId,
          topic.slice("document:".length),
          this.userId,
          Permission.VIEWER,
        );
      } catch {
        // Missing document or insufficient access: treat as a forbidden topic
        // so the caller reports it rather than tearing the whole frame down.
        return false;
      }
      return true;
    }

    // Pure change signals — the run data is fetched via ACL-checked endpoints —
    // but which runs exist is space-wide information.
    if (isWorkflowRunRealtimeTopic(topic)) {
      return await hasSpaceRole();
    }

    return false;
  }

  /**
   * A space-viewer verdict for one frame, computed at most once so a frame
   * naming several space topics costs a single lookup. Deliberately not cached
   * on the connection, so a revoked role stops authorizing subscriptions.
   */
  private spaceRoleResolver(): () => Promise<boolean> {
    let verdict: Promise<boolean> | undefined;
    return () => {
      verdict ??= verifySpaceRole(this.spaceId, this.userId, Permission.VIEWER).then(
        () => true,
        () => false,
      );
      return verdict;
    };
  }
}
