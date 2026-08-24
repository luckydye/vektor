import type { Model } from "@ironcalc/wasm";
import { createMemo, createSignal, Match, onCleanup, onMount, Switch } from "solid-js";
import * as Y from "yjs";
import { api } from "#api/client.ts";
import { browserClientId } from "#composeables/useCollaboration.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useTranslation } from "#composeables/useTranslation.ts";
import { useUserProfile } from "#composeables/useUserProfile.ts";
import type { RemoteSelection, SheetSelection } from "#spreadsheet/presence.ts";
import { SpreadsheetHost } from "#spreadsheet/SpreadsheetHost.tsx";
import { getAvatarColor } from "#utils/avatarColor.ts";

interface Props {
  documentId: string;
  initialHtml?: string;
  canEdit: boolean;
}

const PUBLISH_DEBOUNCE_MS = 200;

export function CsvView(props: Props) {
  const t = useTranslation();
  const { currentSpaceId } = useSpace();
  const documentId = createMemo(() => props.documentId);

  const user = useUserProfile();
  const [model, setModel] = createSignal<Model | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [remoteSelections, setRemoteSelections] = createSignal<RemoteSelection[]>([]);
  let publishSelection: ((selection: SheetSelection) => void) | undefined;

  onMount(async () => {
    const spaceId = currentSpaceId();
    if (!spaceId) return;

    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    let leaveRoom: (() => void) | undefined;
    let connection: { publish: () => void; dispose: () => void } | undefined;
    const doc = new Y.Doc();

    onCleanup(() => {
      clearTimeout(publishTimer);
      connection?.publish();
      connection?.dispose();
      leaveRoom?.();
      doc.destroy();
    });

    try {
      const [{ initEngine }, csvDocument, sheetDoc, collab] = await Promise.all([
        import("#spreadsheet/engine.ts"),
        import("#spreadsheet/csvDocument.ts"),
        import("#spreadsheet/sheetDoc.ts"),
        import("#spreadsheet/collab.ts"),
      ]);
      await initEngine();

      await new Promise<void>((resolve) => {
        leaveRoom = api.joinYjsRoom(spaceId, documentId(), doc, resolve);
      });

      const built = csvDocument.createModel(sheetDoc.htmlFromSheetDoc(doc), "Sheet1");
      connection = collab.connectSheet({
        doc,
        model: built,
        onRemoteChange: () => setRemoteRevision((value) => value + 1),
      });
      setModel(built);
      joinPresence(documentId());
    } catch (error) {
      setLoadError(String(error));
    }

    function joinPresence(room: string): void {
      const localUser = user();
      if (!localUser) return;

      const drop = (clientId: string) =>
        setRemoteSelections((current) =>
          current.filter((entry) => entry.clientId !== clientId),
        );

      const handle = api.joinPresenceRoom<SheetSelection>(
        spaceId as string,
        room,
        browserClientId,
        {
          id: localUser.id,
          name: localUser.name,
          image: localUser.image,
          color: getAvatarColor(localUser.id),
        },
        (event) => {
          if (event.type === "presence-leave") {
            drop(event.clientId);
            return;
          }
          const envelopes =
            event.type === "presence-snapshot" ? event.presences : [event.presence];
          const entries = envelopes.flatMap((envelope) =>
            envelope.clientId === browserClientId || !envelope.state
              ? []
              : [
                  {
                    clientId: envelope.clientId,
                    user: envelope.user,
                    selection: envelope.state,
                  },
                ],
          );
          if (event.type === "presence-snapshot") {
            setRemoteSelections(entries);
            return;
          }
          const [entry] = entries;
          if (!entry) drop(event.presence.clientId);
          else
            setRemoteSelections((current) => [
              ...current.filter((existing) => existing.clientId !== entry.clientId),
              entry,
            ]);
        },
      );
      publishSelection = handle.update;
      onCleanup(() => handle.leave());
    }

    onLocalChange = () => {
      clearTimeout(publishTimer);
      publishTimer = setTimeout(() => connection?.publish(), PUBLISH_DEBOUNCE_MS);
    };
  });

  const [remoteRevision, setRemoteRevision] = createSignal(0);
  let onLocalChange: (() => void) | undefined;

  return (
    <main class="relative flex min-h-0 flex-1 flex-col">
      <Switch>
        <Match when={loadError()}>
          <p class="p-2xs text-neutral-500 text-size-normal">
            {t("The spreadsheet could not be loaded.")} {loadError()}
          </p>
        </Match>
        <Match when={model()}>
          {(loaded) => (
            <SpreadsheetHost
              model={loaded()}
              canEdit={props.canEdit}
              remoteRevision={remoteRevision}
              remoteSelections={remoteSelections}
              onSelectionChange={(selection) => publishSelection?.(selection)}
              onChange={() => onLocalChange?.()}
            />
          )}
        </Match>
        <Match when={!model()}>
          <p class="p-2xs text-neutral-400 text-size-normal">{t("Loading…")}</p>
        </Match>
      </Switch>
    </main>
  );
}
