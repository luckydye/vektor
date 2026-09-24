/**
 * What a write changed, and who needs to hear about it.
 *
 * Repositories describe the change in their own vocabulary and know nothing
 * about topics; this module owns the mapping from a change to the topics it
 * publishes on. `SpaceChange` is a type, so a repository importing it keeps no
 * runtime dependency on the realtime layer.
 */

import { type RealtimeEventInput, realtimeTopics } from "#realtime/protocol.ts";

export type SpaceChange =
  | {
      kind: "category";
      action: "created" | "updated" | "deleted" | "reordered";
      data: Record<string, unknown>;
    }
  | {
      kind: "documentProperties";
      documentId: string;
      affectsTree: boolean;
      data: Record<string, unknown>;
    }
  | { kind: "extensions" }
  | { kind: "audit"; event: string; documentId: string };

/**
 * Both topics carry the same payload: the tree renders categories too.
 *
 * `kind` is part of the wire format — clients switch on it — so it is rebuilt
 * here rather than left implicit in the change's discriminator.
 */
function categoryTopics(
  action: "created" | "updated" | "deleted" | "reordered",
  fields: Record<string, unknown>,
): RealtimeEventInput[] {
  const data = {
    kind: action === "reordered" ? "categories_reordered" : `category_${action}`,
    ...fields,
  };
  return [
    { topic: realtimeTopics.categories, data },
    { topic: realtimeTopics.documentTree, data },
  ];
}

export const documentLockChangedKind = "document_lock_changed";

/**
 * Which audit events reach clients. An event not listed here is recorded in the
 * audit log without any websocket traffic — the empty list is the decision, not
 * an oversight.
 */
function auditTopics(event: string, docId: string): RealtimeEventInput[] {
  switch (event) {
    case "lock":
    case "unlock":
      return [
        realtimeTopics.documents,
        {
          topic: realtimeTopics.document(docId),
          data: { kind: documentLockChangedKind, documentId: docId },
        },
      ];
    case "save":
      return [realtimeTopics.documents, realtimeTopics.document(docId)];
    case "acl_grant":
    case "acl_revoke":
      return [realtimeTopics.acl];
    case "publish":
    case "unpublish":
    case "restore":
    case "archive":
    case "delete":
    case "create":
      return [
        realtimeTopics.documents,
        realtimeTopics.documentTree,
        realtimeTopics.document(docId),
      ];
    default:
      return [];
  }
}

export function changeToEvents(change: SpaceChange): RealtimeEventInput[] {
  switch (change.kind) {
    case "category":
      return categoryTopics(change.action, change.data);
    case "extensions":
      return [realtimeTopics.extensions];
    case "audit":
      return auditTopics(change.event, change.documentId);
    case "documentProperties":
      return [
        { topic: realtimeTopics.properties, data: change.data },
        { topic: realtimeTopics.document(change.documentId), data: change.data },
        ...(change.affectsTree
          ? [
              { topic: realtimeTopics.documentTree, data: change.data },
              { topic: realtimeTopics.categoryDocuments, data: change.data },
            ]
          : []),
      ];
  }
}
