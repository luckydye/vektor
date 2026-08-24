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
  /** Unused now the grid comes from the room; kept for the caller's shape. */
  initialHtml?: string;
  canEdit: boolean;
}

/**
 * How long after an edit before it is published to the room. Short enough to
 * feel live, long enough that a burst of typing is one update rather than one
 * per keystroke.
 */
const PUBLISH_DEBOUNCE_MS = 200;

/**
 * Spreadsheet view for `csv` documents.
 *
 * The grid lives in a collaborative document, the same Yjs room the rich-text
 * documents use — so two people can be in a sheet at once and their edits merge
 * instead of overwriting each other. The server owns the room and persists it
 * back to the `<table>` markup the document has always stored, which is why
 * there is no save call here.
 *
 * The client joins empty and waits for the server's state before building its
 * model: seeding a document locally makes two histories that never reconcile.
 */
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
      // A pending edit would otherwise be lost on the way out.
      connection?.publish();
      connection?.dispose();
      leaveRoom?.();
      doc.destroy();
    });

    try {
      // The engine is a ~2 MB wasm module and the grid only runs in a browser,
      // so both are loaded here rather than imported at the top level: this
      // component is server-rendered as part of the document page.
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

    /**
     * Cursors ride the same presence room the editor uses; the server treats
     * the payload as opaque, so a selection needs no protocol of its own.
     */
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
          // An update carries one peer: replace just that one.
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

    // Publishing is debounced, and every edit resets the timer.
    onLocalChange = () => {
      clearTimeout(publishTimer);
      publishTimer = setTimeout(() => connection?.publish(), PUBLISH_DEBOUNCE_MS);
    };
  });

  // Bumped when a peer's edit lands, so the grid repaints.
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
