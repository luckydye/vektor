import { type Accessor, createMemo } from "solid-js";
import { channelOfBotPrincipal, sourceOfEventAuthor } from "#acl/permissions.ts";
import { api, type ChatSession, type CurrentUser, type User } from "#api/client.ts";
import type { PublicUserAppearance } from "#cosmetics/types.ts";
import { realtimeTopics } from "#realtime/protocol.ts";
import { useQuery, useQueryClient } from "./query.ts";
import { useCosmetics } from "./useCosmetics.ts";
import { useSpace } from "./useSpace.ts";
import { useSync } from "./useSync.ts";
import { useUserProfile } from "./useUserProfile.ts";

/**
 * Every chat query of the space refreshes on any `space:chat` event: the events
 * coalesce per topic, so which session one names cannot be relied on.
 */
function useChatSync(spaceId: Accessor<string | null>) {
  const queryClient = useQueryClient();
  useSync(spaceId, [realtimeTopics.chat], () => {
    void queryClient.invalidateQueries({ queryKey: ["chat-channels", spaceId()] });
    void queryClient.invalidateQueries({ queryKey: ["chat-threads", spaceId()] });
  });
}

/** The space's bot channels, kept current by the realtime feed; `undefined` until loaded. */
export function useBotChannels() {
  const { currentSpaceId } = useSpace();
  useChatSync(currentSpaceId);
  const { data } = useQuery<ChatSession[]>({
    queryKey: createMemo(() => ["chat-channels", currentSpaceId()]),
    queryFn: async () => await api.chatSessions.list(currentSpaceId() as string),
    enabled: createMemo(() => !!currentSpaceId()),
  });
  return data;
}

/** A channel's threads by the message they reply to. */
export function useChatThreads(channelId: Accessor<string | null>) {
  const { currentSpaceId } = useSpace();
  useChatSync(currentSpaceId);
  const { data } = useQuery<ChatSession[]>({
    queryKey: createMemo(() => ["chat-threads", currentSpaceId(), channelId()]),
    queryFn: async () =>
      await api.chatSessions.threads(currentSpaceId() as string, channelId() as string),
    enabled: createMemo(() => !!currentSpaceId() && !!channelId()),
  });
  return createMemo(
    () => new Map((data() ?? []).map((thread) => [thread.threadRootSeq as number, thread])),
  );
}

/** Who posts in the space's channels, and who is looking. */
export function useChatPeople() {
  const { currentSpaceId } = useSpace();
  const { data: members } = useQuery<User[]>({
    queryKey: createMemo(() => ["space-users", currentSpaceId()]),
    queryFn: async () => await api.users.get(currentSpaceId() as string),
    enabled: createMemo(() => !!currentSpaceId()),
  });
  const { data: me } = useQuery<CurrentUser>({
    queryKey: ["current_user"],
    queryFn: () => api.users.me(),
  });
  const channels = useBotChannels();
  // The viewer as their own avatar shows them: the profile with the cosmetics
  // they wear. The member list can miss them too, as without an auth database.
  const profile = useUserProfile();
  const { appearance } = useCosmetics();
  const viewer = createMemo((): ChatAuthor | undefined => {
    const own = profile() ?? me();
    return own && { ...own, appearance: appearance() };
  });
  const byId = createMemo(() => new Map((members() ?? []).map((user) => [user.id, user])));
  return {
    currentUserId: createMemo(() => me()?.id ?? null),
    /** A person, or a bot posting through a task it scheduled itself. */
    authorOf: (id: string): ChatAuthor | undefined => {
      const source = sourceOfEventAuthor(id);
      if (source) return { name: source, event: true };
      const channelId = channelOfBotPrincipal(id);
      if (!channelId) return id === me()?.id ? viewer() : byId().get(id);
      const channel = channels()?.find((candidate) => candidate.id === channelId);
      return channel && { name: channel.title, bot: { avatar: channel.avatar } };
    },
  };
}

/** Who posted a message, as the timeline draws them. */
export type ChatAuthor = {
  name: string;
  image?: string | null;
  email?: string | null;
  /** The cosmetics a person's avatar wears. */
  appearance?: PublicUserAppearance;
  /** Set when a bot posted it: a task the bot scheduled itself. */
  bot?: { avatar: string | null };
  /** Set when an outside service posted it; `name` is the service. */
  event?: true;
};

/** A bot as its editor fills it in. */
export type BotDraft = {
  title: string;
  avatar: string;
  rolePrompt: string;
  access: "viewer" | "editor";
  /** Fixed once the bot exists. */
  node: string | null;
  nodeAgent: string | null;
};

/** Creating, editing and deleting bots, and opening threads. */
export function useBotActions() {
  const { currentSpaceId } = useSpace();
  const queryClient = useQueryClient();
  const spaceId = () => {
    const id = currentSpaceId();
    if (!id) throw new Error("No active space selected");
    return id;
  };
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["chat-channels", currentSpaceId()] });
    queryClient.invalidateQueries({ queryKey: ["chat-threads", currentSpaceId()] });
  };

  return {
    async create(draft: BotDraft): Promise<string> {
      const id = await api.chatSessions.create(spaceId(), {
        visibility: "space",
        title: draft.title,
        avatar: draft.avatar || undefined,
        rolePrompt: draft.rolePrompt || undefined,
        access: draft.access,
        node: draft.node,
        nodeAgent: draft.nodeAgent,
      });
      refresh();
      return id;
    },
    async update(botId: string, draft: BotDraft): Promise<void> {
      await api.chatSessions.update(spaceId(), botId, {
        title: draft.title,
        avatar: draft.avatar || null,
        rolePrompt: draft.rolePrompt || null,
        access: draft.access,
      });
      refresh();
    },
    async remove(botId: string): Promise<void> {
      await api.chatSessions.delete(spaceId(), botId);
      refresh();
    },
    /** The thread replying to a channel message, started if it has none. */
    async openThread(channelId: string, rootSeq: number): Promise<string> {
      const id = await api.chatSessions.create(spaceId(), {
        visibility: "space",
        parentSessionId: channelId,
        threadRootSeq: rootSeq,
      });
      refresh();
      return id;
    },
  };
}

/** The agents each node or runner the user may run agents on offers; `undefined` until loaded. */
export function useAgentRunnerAgents(enabled: Accessor<boolean>) {
  const { currentSpaceId } = useSpace();
  const { data } = useQuery<Record<string, string[]>>({
    queryKey: createMemo(() => ["runner-agents", currentSpaceId()]),
    queryFn: async () => await api.runners.agents(currentSpaceId() as string),
    enabled: createMemo(() => !!currentSpaceId() && enabled()),
  });
  return data;
}
