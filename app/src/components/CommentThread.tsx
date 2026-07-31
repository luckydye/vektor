import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { useMembers } from "#composeables/useMembers.solid.ts";
import { useUserProfile } from "#composeables/useUserProfile.solid.ts";
import { formatRelativeTime } from "#utils/datetime.ts";
import { renderMessageMarkdown } from "#utils/markdown.ts";
import { findMemberUser, userDisplayName } from "#utils/userDisplay.ts";
import "#editor/css/mentions.css";
import { cancelIcon, confirmationIcon, deleteEntryIcon } from "#assets/icons.ts";
import "./AvatarElement.ts";
import { Button } from "./Button.tsx";
import { MessageInput } from "./MessageInput.tsx";

export interface Comment {
  id: string;
  content: string;
  createdAt: string;
  createdBy: string;
  createdByUser?: {
    image?: string | null;
    name?: string | null;
  } | null;
  reference?: string;
  parentId?: string | null;
  resourceType?: string;
  resourceId?: string;
}

interface Props {
  spaceId: string;
  documentId: string;
  comments: Comment[];
  activeReference?: string | null;
  isSubmitting?: boolean;
  isDeletingComment?: boolean;
  onSubmit?: (payload: { content: string; reference: string | null }) => void;
  onDelete?: (commentId: string) => void;
  onResolve?: () => void;
  onClose?: () => void;
}

export function CommentThread(props: Props) {
  const { members } = useMembers();
  const currentUser = useUserProfile();

  const [newCommentContent, setNewCommentContent] = createSignal("");
  let commentListRef: HTMLDivElement | undefined;

  const getUser = (comment: Comment) =>
    comment.createdByUser ?? findMemberUser(members(), comment.createdBy);

  const getUserName = (comment: Comment): string =>
    userDisplayName(getUser(comment), comment.createdBy);

  function getRelativeTime(dateString: string) {
    return formatRelativeTime(dateString, { style: "narrow" });
  }

  function handleSubmit() {
    if (!newCommentContent().trim()) return;

    props.onSubmit?.({
      content: newCommentContent(),
      reference: props.activeReference || null,
    });

    setNewCommentContent("");
  }

  function handleDeleteComment(commentId: string) {
    if (confirm("Are you sure you want to delete this comment?")) {
      props.onDelete?.(commentId);
    }
  }

  const commentCount = createMemo(() => props.comments.length);

  createEffect(
    on(
      commentCount,
      () => {
        // Solid has already rendered the new comment by the time this runs.
        if (commentListRef) commentListRef.scrollTop = commentListRef.scrollHeight;
      },
      { defer: true },
    ),
  );

  return (
    <div class="flex h-full max-h-[600px] w-80 flex-col rounded-lg border border-neutral-100 bg-background shadow-xl">
      {/* Header */}
      <div class="flex items-center justify-between rounded-t-lg border-neutral-100 border-b bg-neutral-50/80 p-3 backdrop-blur-sm">
        <div class="flex items-center gap-2">
          <h3 class="font-semibold text-neutral-800 text-size-medium">Thread</h3>
          <Show when={props.comments.length > 0}>
            <span class="rounded-full bg-neutral-200/50 px-1.5 py-0.5 font-medium text-[10px] text-neutral-500">
              {props.comments.length}
            </span>
          </Show>
        </div>
        <div class="flex items-center gap-1">
          <Show when={props.comments.length > 0}>
            <Button
              variant="ghost"
              onClick={() => props.onResolve?.()}
              class="h-6 w-6 p-1 text-neutral-400 hover:text-green-600"
              ariaLabel="Resolve thread"
            >
              <div class="svg-icon h-4 w-4" innerHTML={confirmationIcon} />
            </Button>
          </Show>
          <Button
            variant="ghost"
            onClick={() => props.onClose?.()}
            class="-mr-1 h-6 w-6 p-1 text-neutral-400 hover:text-neutral-700"
            ariaLabel="Close thread"
          >
            <div class="svg-icon h-4 w-4" innerHTML={cancelIcon} />
          </Button>
        </div>
      </div>

      {/* Comments List */}
      <div ref={commentListRef} class="flex-1 space-y-4 overflow-y-auto p-3">
        <Show when={props.comments.length === 0}>
          <div class="flex h-24 flex-col items-center justify-center text-center text-neutral-400">
            <p class="font-medium text-neutral-500 text-size-medium">No comments yet</p>
            <p class="text-size-small opacity-75">Start the conversation!</p>
          </div>
        </Show>

        <For each={props.comments}>
          {(comment) => (
            <div class="group flex gap-2">
              <vektor-avatar
                size="24"
                attr:user-id={comment.createdBy}
                prop:user={getUser(comment)}
                class="mt-0.5 shrink-0"
              />

              <div class="min-w-0 flex-1">
                <div class="mb-0.5 flex items-baseline gap-2">
                  <span class="truncate font-semibold text-neutral-900 text-size-small">
                    {getUserName(comment)}
                  </span>
                  <span class="whitespace-nowrap text-[10px] text-neutral-400">
                    {getRelativeTime(comment.createdAt)}
                  </span>
                  <Show when={currentUser()?.id === comment.createdBy}>
                    <Button
                      variant="ghost"
                      onClick={() => handleDeleteComment(comment.id)}
                      disabled={props.isDeletingComment}
                      class="ml-auto h-5 w-5 p-0.5 text-neutral-400 opacity-0 transition-opacity hover:text-red-600 group-hover:opacity-100"
                      ariaLabel="Delete comment"
                    >
                      <div class="svg-icon h-3 w-3" innerHTML={deleteEntryIcon} />
                    </Button>
                  </Show>
                </div>

                <div
                  class="comment-markdown break-words text-neutral-700 text-size-medium leading-relaxed"
                  innerHTML={renderMessageMarkdown(comment.content)}
                />
              </div>
            </div>
          )}
        </For>
      </div>

      {/* Input Area */}
      <div class="p-5xs">
        <div class="rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2">
          <MessageInput
            value={newCommentContent()}
            onInput={setNewCommentContent}
            mentions
            spaceId={props.spaceId}
            documentId={props.documentId}
            placeholder="Reply..."
            rows={2}
            submitKey="ctrl+enter"
            disabled={props.isSubmitting || !newCommentContent().trim()}
            onSubmit={handleSubmit}
          />
        </div>
      </div>
    </div>
  );
}
