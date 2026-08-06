import { useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { twMerge } from "tailwind-merge";
import { api } from "#api/client.ts";
import { AppView } from "#components/AppView.tsx";
import { BottomBanner } from "#components/BottomBanner.tsx";
import { Breadcrumbs } from "#components/Breadcrumbs.tsx";
import { CanvasView } from "#components/CanvasView.tsx";
import { CsvView } from "#components/CsvView.tsx";
import {
  DatabaseDocumentView,
  type DatabaseExtensionView,
} from "#components/DatabaseDocumentView.tsx";
import { DocumentActions } from "#components/DocumentActions.tsx";
import { DocumentContent } from "#components/DocumentContent.tsx";
import { DocumentExtensionViews } from "#components/DocumentExtensionViews.tsx";
import { DocumentProperties } from "#components/DocumentProperties.tsx";
import { HeaderImage } from "#components/HeaderImage.tsx";
import { NewDocumentPicker } from "#components/NewDocumentPicker.tsx";
import { RestoreButton } from "#components/RestoreButton.tsx";
import { RevisionsSidebar } from "#components/RevisionsSidebar.tsx";
import { RevisionView } from "#components/RevisionView.tsx";
import { TitleEditor } from "#components/TitleEditor.tsx";
import { WorkflowView } from "#components/WorkflowView.tsx";
import { useQuery } from "#composeables/query.ts";
import { useDocumentContext } from "#composeables/useDocument.ts";
import { editing, resetEditingState } from "#composeables/useEditor.ts";
import { useExtensions } from "#composeables/useExtensions.ts";
import { usePageTitle } from "#composeables/usePageTitle.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.ts";
import { useToast } from "#composeables/useToast.ts";
import { optionalPropertyValueToText } from "#documents/properties.ts";
import { placeholderDocumentTitle, readOnlyDocumentTypes } from "#documents/types.ts";
import { formatRelativeTime } from "#utils/datetime.ts";
import { isWorkflowCreationEnabled } from "#utils/spacePreferences.ts";
import { spacePath } from "#utils/utils.ts";

interface Props {
  documentSlug?: string;
  draftType?: string;
  draftCategory?: string;
  /** Seeds the title of a draft — the command palette's "create with title". */
  draftTitle?: string;
  /** The server's clock, so the first "Updated …" matches the SSR output. */
  ssrNow?: number;
}

const AUTO_CREATE_TYPES: Record<string, { title: string; content: string }> = {
  database: { title: placeholderDocumentTitle("database"), content: "<p></p>" },
  canvas: {
    title: placeholderDocumentTitle("canvas"),
    content: JSON.stringify({ version: 1, shapes: [], strokes: [] }),
  },
  // Workflow content is the script source. It has to be non-empty — the create
  // route rejects empty content — so a new workflow starts as a comment header.
  workflow: {
    title: placeholderDocumentTitle("workflow"),
    content: [
      "// Workflow script.",
      "// `await runJob(extensionId, jobId, inputs)` runs an extension job and",
      "// resolves with its outputs. The value you return becomes the run result.",
      "",
    ].join("\n"),
  },
  // Spreadsheets are backed by CSV — the create route renders it to the table
  // HTML that gets stored, so this is a header row plus three empty rows.
  csv: { title: placeholderDocumentTitle("csv"), content: "A,B,C\n,,\n,,\n,,\n" },
};

export function DocumentPageView(props: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const [now, setNow] = createSignal(props.ssrNow ?? Date.now());

  const { currentSpace } = useSpace();
  const { extensions } = useExtensions();
  const toast = useToast();
  const { canUseDocumentEditor, setDocumentContext, resetDocumentContext } =
    useDocumentContext();

  const isDraft = createMemo(() => !props.documentSlug);
  const draftTypeParam = createMemo(() => props.draftType ?? "");
  const showPicker = createMemo(() => isDraft() && !draftTypeParam());
  const draftCategory = createMemo(() =>
    isDraft() ? props.draftCategory || undefined : undefined,
  );
  const draftTitle = createMemo(() =>
    isDraft() ? props.draftTitle?.trim() || undefined : undefined,
  );

  const docQuery = useQuery({
    queryKey: createMemo(() => [
      "wiki_document_slug",
      currentSpace()?.id,
      props.documentSlug,
    ]),
    queryFn: async () => {
      const spaceId = currentSpace()?.id;
      if (!spaceId || !props.documentSlug) return null;
      return await api.document.get(spaceId, props.documentSlug);
    },
    initialData: async () => {
      const spaceId = currentSpace()?.id;
      if (!spaceId || !props.documentSlug) return undefined;
      return await api.document.getCached(spaceId, props.documentSlug);
    },
    subscribe: (callback) => {
      const spaceId = currentSpace()?.id;
      if (!spaceId || !props.documentSlug) return () => {};
      return api.document.subscribeCached(spaceId, props.documentSlug, callback);
    },
    enabled: createMemo(() => !isDraft() && !!currentSpace()?.id && !!props.documentSlug),
  });

  const doc = createMemo(() => docQuery.data());

  const breadcrumbsQuery = useQuery({
    queryKey: createMemo(() => ["document_breadcrumbs", currentSpace()?.id, doc()?.id]),
    queryFn: async () => {
      const spaceId = currentSpace()?.id;
      const docId = doc()?.id;
      if (!spaceId || !docId) return [];
      return await api.documentBreadcrumbs.get(spaceId, docId);
    },
    enabled: createMemo(() => !isDraft() && !!currentSpace()?.id && !!doc()?.id),
  });

  const categoriesQuery = useQuery({
    queryKey: createMemo(() => ["categories", currentSpace()?.id]),
    queryFn: async () => {
      const spaceId = currentSpace()?.id;
      if (!spaceId) return [];
      return (await api.categories.get(spaceId)).categories;
    },
    enabled: createMemo(() => !isDraft() && !!currentSpace()?.id),
  });

  const titleDragUrl = createMemo(() => {
    const slug = doc()?.slug;
    return slug ? spacePath(currentSpace()?.slug, `/doc/${slug}`) : undefined;
  });

  // Redirect /doc/documentId → /doc/documentSlug once the document resolves.
  createEffect(() => {
    const d = doc();
    if (!d || props.documentSlug === d.slug) return;
    // `location.pathname` already carries the router base ("/{space}/"), so the
    // target must not be resolved against it again — that yields "/space/space/…".
    const fullPath = `${location.pathname}${location.search}${location.hash}`;
    navigate(fullPath.replace(`/doc/${props.documentSlug}`, `/doc/${d.slug}`), {
      replace: true,
      resolve: false,
    });
  });

  const allBreadcrumbs = createMemo(() => breadcrumbsQuery.data() ?? []);
  // exclude the current doc from breadcrumbs
  const parentBreadcrumbs = createMemo(() => allBreadcrumbs().slice(0, -1));

  const docCategory = createMemo(() => {
    const categories = categoriesQuery.data();
    if (!categories) return null;
    // Walk the breadcrumb chain from root to current and use the first category found.
    for (const crumb of allBreadcrumbs()) {
      if (crumb.categorySlug) {
        return categories.find((c) => c.slug === crumb.categorySlug) ?? null;
      }
    }
    return null;
  });

  const documentType = createMemo(() =>
    isDraft() ? draftTypeParam() || "document" : (doc()?.type ?? "document"),
  );

  const isCanvas = createMemo(() => documentType() === "canvas");
  const isApp = createMemo(() => documentType() === "app");
  const isCsv = createMemo(() => documentType() === "csv");
  const isWorkflow = createMemo(() => documentType() === "workflow");
  const isDatabase = createMemo(() => documentType() === "database");
  // A spreadsheet is a full-width document, not a full-bleed surface like the
  // canvas: the container spans the window but the grid keeps the same side
  // inset as the breadcrumb and the chips above it.
  const isPaddedDocument = createMemo(
    () => !isCanvas() && !isApp() && !isWorkflow() && !isDatabase(),
  );

  /**
   * Compared by value: `For` keys on item identity and `ExtensionView` remounts
   * the extension when its props change, so rebuilding this list on every
   * extensions-cache write would tear down and remount every embedded view —
   * and a mounted extension writes to that cache by calling the API.
   */
  const documentRightViews = createMemo(
    () => {
      if (isDraft() || documentType() !== "document") return [];

      return extensions().flatMap((extension) =>
        (extension.routes || [])
          .filter((route) => route.placements?.includes("document"))
          .map((route) => ({ extensionId: extension.id, route })),
      );
    },
    undefined,
    {
      equals: (a, b) =>
        a.length === b.length &&
        a.every(
          (view, index) =>
            view.extensionId === b[index]?.extensionId &&
            view.route.path === b[index]?.route.path,
        ),
    },
  );

  // `Init` spelled out as `undefined`: there is no initial value, and it is only
  // passed at all because `equals` is the third argument.
  const databaseViews = createMemo<DatabaseExtensionView[], undefined>(
    () => {
      if (isDraft() || !isDatabase()) return [];

      return extensions().flatMap((extension) =>
        (extension.routes || [])
          .filter((route) => route.placements?.includes("database"))
          .map((route) => ({
            extensionId: extension.id,
            extensionName: extension.name,
            route,
          })),
      );
    },
    undefined,
    {
      equals: (a, b) =>
        a.length === b.length &&
        a.every(
          (view, index) =>
            view.extensionId === b[index]?.extensionId &&
            view.extensionName === b[index]?.extensionName &&
            view.route.path === b[index]?.route.path &&
            view.route.title === b[index]?.route.title,
        ),
    },
  );

  const userCanEdit = createMemo(() => canEdit(currentSpace()?.userRole));

  const isReadonly = createMemo(() =>
    isDraft()
      ? false
      : !!(
          doc()?.readonly ||
          doc()?.archived ||
          isCanvas() ||
          isApp() ||
          isWorkflow() ||
          isDatabase() ||
          readOnlyDocumentTypes.includes(documentType())
        ),
  );

  const title = createMemo(() =>
    isDraft()
      ? (draftTitle() ?? placeholderDocumentTitle(documentType()))
      : (doc()?.properties?.title as string) || placeholderDocumentTitle("document"),
  );

  // Header image + its server-derived orientation. The API reads dimensions from
  // storage so the layout is already decided during SSR.
  const headerImageSrc = createMemo(() =>
    optionalPropertyValueToText(doc()?.properties?.headerImage),
  );
  const headerImageAspectRatio = createMemo(() => doc()?.headerImageAspectRatio ?? null);
  // A portrait header switches to a two-column layout (image beside the title).
  // Without a known aspect ratio we keep the existing full-width banner.
  const isPortraitHeader = createMemo(() => {
    const ratio = headerImageAspectRatio();
    return !isDraft() && !!headerImageSrc() && ratio !== null && ratio < 1;
  });

  const defaultLayout = createMemo(() =>
    documentType() === "document" ? "document" : "full",
  );
  const effectiveLayout = createMemo(() =>
    isDraft() ? defaultLayout() : doc()?.properties?.layout || defaultLayout(),
  );

  const updatedAtStr = createMemo(() => {
    const updatedAt = doc()?.updatedAt;
    return updatedAt ? formatRelativeTime(updatedAt, { now: now() }) : "";
  });

  const [redirecting, setRedirecting] = createSignal(false);
  // `ClientOnly` and the sidebar portal both need the DOM.
  const [hasMounted, setHasMounted] = createSignal(false);

  async function maybeAutoCreateDraft() {
    if (!hasMounted()) return;
    if (!isDraft()) return;
    if (redirecting()) return;
    const autoCreate = AUTO_CREATE_TYPES[documentType()];
    const space = currentSpace();
    if (!autoCreate || !space) return;
    if (documentType() === "workflow" && !isWorkflowCreationEnabled(space.preferences)) {
      navigate("/new", { replace: true });
      return;
    }
    if (!userCanEdit()) {
      navigate("/");
      return;
    }
    setRedirecting(true);
    try {
      const newDoc = await api.documents.post(space.id, {
        type: documentType(),
        content: autoCreate.content,
        properties: {
          title: draftTitle() ?? autoCreate.title,
          ...(draftCategory() ? { category: draftCategory() } : {}),
        },
      });
      navigate(`/doc/${newDoc.slug}`);
    } catch (error) {
      setRedirecting(false);
      throw error;
    }
  }

  onMount(() => {
    setHasMounted(true);
    setNow(Date.now());
  });

  createEffect(() => {
    // Track the inputs the draft decision depends on.
    void [isDraft(), documentType(), currentSpace(), userCanEdit(), draftCategory()];
    void maybeAutoCreateDraft().catch((error) => {
      console.error("Failed to create draft document", error);
      toast.error(
        error instanceof Error ? error.message : "Failed to create the document",
      );
    });
  });

  onCleanup(() => {
    resetEditingState();
    resetDocumentContext();
  });

  usePageTitle(title);

  // Keep the shared document context in sync with the current document.
  // Runs during setup (SSR + client) so the context is correct before any child
  // component renders. Replaces the renderless DocumentContextProvider component.
  createEffect(() => {
    setDocumentContext({
      documentId: doc()?.id,
      documentType: documentType(),
      readonly: isReadonly(),
      publishedVersion: doc()?.publishedRev ?? null,
      userCanEdit: userCanEdit(),
    });
    if (!canUseDocumentEditor() && editing()) resetEditingState();
  });

  const initialProperties = () =>
    isDraft()
      ? draftCategory()
        ? { category: draftCategory() }
        : {}
      : { ...doc()?.properties, parentId: doc()?.parentId };

  /** Title row. A draft has no document to drag, so it renders a plain div. */
  const titleRow = (): JSX.Element => (
    <div class="flex w-full items-start justify-between">
      <Dynamic
        component={isDraft() ? "div" : "page-target"}
        class="block min-w-0 flex-1 [&[data-dragging]]:opacity-50"
        data-document-id={doc()?.id}
        data-document-type={doc()?.type ?? undefined}
        data-space-id={currentSpace()?.id}
        data-document-url={titleDragUrl()}
      >
        <TitleEditor
          initialEditMode={isDraft()}
          title={title()}
          documentId={doc()?.id}
          spaceId={currentSpace()?.id as string}
          canEdit={userCanEdit()}
        />
      </Dynamic>
    </div>
  );

  const documentPropertiesBlock = (layout?: "labeled"): JSX.Element => (
    <DocumentProperties
      documentId={doc()?.id}
      documentType={documentType()}
      layout={layout}
      readonly={!userCanEdit()}
      initialProperties={initialProperties()}
      initialCategory={null}
    />
  );

  const breadcrumbs = (): JSX.Element => (
    <Show when={!isDraft()}>
      <Breadcrumbs
        category={docCategory()}
        parents={parentBreadcrumbs()}
        currentTitle={title()}
      />
    </Show>
  );

  return (
    <>
      <Show
        when={currentSpace() && (isDraft() ? !redirecting() : doc())}
        fallback={
          <Show when={!isDraft()}>
            <Show
              when={!docQuery.isLoading()}
              fallback={
                <div class="flex h-64 items-center justify-center text-neutral-400">
                  Loading…
                </div>
              }
            >
              <div class="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-neutral-500">
                <p class="font-semibold text-2xl text-neutral-800">404</p>
                <p>Document not found.</p>
                <a
                  href={`/${currentSpace()?.slug ?? ""}/`}
                  class="text-sm underline hover:text-neutral-800"
                >
                  Back to space
                </a>
              </div>
            </Show>
          </Show>
        }
      >
        {/* Data views size themselves to what is left of the window rather than
            to their content, so every box between here and the view is a flex
            column that may shrink. Without an unbroken chain, an extension view
            whose contents use `height: 100%` resolves to zero height. */}
        <div
          class={twMerge(
            (isCsv() || isDatabase()) && "flex h-full min-h-screen flex-col",
          )}
        >
          <inset-view
            class={twMerge(
              "block min-h-0 flex-1",
              (isCsv() || isDatabase()) && "flex flex-col",
              !isCanvas() && "md:mr-(--inset-right) md:ml-(--inset-left)",
            )}
          >
            <div
              data-type={documentType()}
              data-updated-at={doc()?.updatedAt as string | undefined}
              data-created-at={doc()?.createdAt as string | undefined}
              data-layout={effectiveLayout()}
              class={twMerge(
                "relative mx-auto flex h-full w-full flex-col",
                (isCsv() || isDatabase()) && "min-h-0 flex-1",
                isCsv() || isDatabase() || effectiveLayout() === "full"
                  ? "max-w-full"
                  : "max-w-(--document-width)",
              )}
            >
              <Show when={doc()?.archived}>
                <BottomBanner class="archived-banner">
                  <div class="pointer-events-auto flex w-full flex-col gap-3 rounded-lg border border-yellow-200 bg-yellow-50 px-5 py-4 shadow-large sm:flex-row sm:items-center sm:justify-between">
                    <div class="min-w-0">
                      <p class="font-semibold text-size-medium text-yellow-900">
                        ⚠️ This document is archived
                      </p>
                      <p class="my-0! text-size-small text-yellow-700">
                        This document has been archived and is no longer actively
                        maintained.
                      </p>
                    </div>
                    <RestoreButton documentId={doc()?.id as string} />
                  </div>
                </BottomBanner>
              </Show>

              <Show when={isCanvas()}>
                <div class="pointer-events-none absolute top-0 right-0 left-0 z-20 block md:right-(--inset-right) md:left-(--inset-left)">
                  <div class="sticky top-0 z-10 flex min-h-7 flex-row items-center justify-between gap-6 px-xs py-4 md:px-m">
                    <div class="min-w-0 flex-1">{breadcrumbs()}</div>
                    <DocumentActions title={title()} headerImage={headerImageSrc()} />
                  </div>

                  <inset-view class="flex flex-row justify-between gap-6 px-xs py-3xs md:gap-4 md:px-m print:px-0">
                    {titleRow()}
                  </inset-view>

                  <inset-view
                    id="document-properties"
                    class="mb-l block px-xs md:px-m print:px-0"
                  >
                    {documentPropertiesBlock()}
                  </inset-view>
                </div>
              </Show>

              {/* Portrait header image: image column beside the title/properties */}
              <Show when={!isCanvas() && !isApp() && isPortraitHeader()}>
                <div class="sticky top-0 z-10 flex min-h-7 flex-row items-center justify-between gap-6 border-neutral-50 border-b bg-neutral-10 px-xs py-4 md:px-m">
                  <div class="min-w-0 flex-1">{breadcrumbs()}</div>
                  <DocumentActions title={title()} headerImage={headerImageSrc()} />
                </div>

                <div class="mb-4 flex flex-col gap-xl px-xs md:flex-row md:items-start md:px-xl print:px-0">
                  <HeaderImage
                    class="w-full max-w-[320px] shrink-0"
                    orientation="portrait"
                    aspectRatio={headerImageAspectRatio()}
                    documentId={doc()?.id as string}
                    initialSrc={headerImageSrc()}
                  />

                  <div class="flex min-w-0 flex-1 flex-col">
                    <inset-view class="flex flex-row justify-between gap-6 bg-neutral-10 py-3xs md:gap-4 print:px-0">
                      {titleRow()}
                    </inset-view>

                    <inset-view id="document-properties" class="mb-l block print:px-0">
                      {documentPropertiesBlock("labeled")}
                    </inset-view>
                  </div>
                </div>
              </Show>

              <Show when={!isCanvas() && !isApp() && !isPortraitHeader()}>
                <Show when={!isDraft() && !isWorkflow()}>
                  <HeaderImage
                    class="mt-4"
                    documentId={doc()?.id as string}
                    initialSrc={optionalPropertyValueToText(
                      doc()?.properties?.headerImage,
                    )}
                  />
                </Show>

                <div class="sticky top-0 z-10 flex min-h-7 flex-row items-center justify-between gap-6 border-neutral-50 border-b bg-neutral-10 px-xs py-4 md:px-m">
                  <Show
                    when={isWorkflow()}
                    fallback={<div class="min-w-0 flex-1">{breadcrumbs()}</div>}
                  >
                    <div id="workflow-breadcrumb-slot" class="min-w-0 flex-1" />
                  </Show>
                  <DocumentActions title={title()} headerImage={headerImageSrc()} />
                </div>

                {/* A spreadsheet carries its name in the breadcrumb instead: the
                    grid wants the vertical space, and a heading above a formula
                    bar reads as a cell rather than a title. */}
                <Show when={!isCsv()}>
                  <inset-view class="flex flex-row justify-between gap-6 bg-neutral-10 px-xs py-3xs md:gap-4 md:px-m print:px-0">
                    {titleRow()}
                  </inset-view>
                </Show>

                {/* A spreadsheet brings its own toolbar right underneath, so the
                    chips sit closer to it than prose content would. */}
                <inset-view
                  id="document-properties"
                  class={`block px-xs md:px-m print:px-0 ${isCsv() ? "mb-3xs" : "mb-l"}`}
                >
                  {documentPropertiesBlock()}
                </inset-view>
              </Show>

              <div
                class={twMerge(
                  // Continues the flex column down to the grid; see the wrapper
                  // at the top of this view.
                  (isCsv() || isDatabase()) && "flex min-h-0 flex-1 flex-col",
                  documentRightViews().length > 0 &&
                    "lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6",
                )}
              >
                <div
                  class={twMerge(
                    "min-w-0",
                    (isCsv() || isDatabase()) && "flex min-h-0 flex-1 flex-col",
                  )}
                >
                  <div
                    class={twMerge(
                      "h-full max-w-none overflow-x-auto text-neutral-700",
                      isCsv() || isDatabase()
                        ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                        : "h-full overflow-x-auto",
                      isPaddedDocument() && "px-xs md:px-m print:px-0",
                      // The grid ends the page, so it closes it with the same
                      // gap the sticky header opens it with (`py-4`).
                      isCsv() && "pb-4",
                      isWorkflow() && "overflow-inherit",
                    )}
                  >
                    <Show
                      when={!isDraft()}
                      fallback={
                        <>
                          <Show when={showPicker()}>
                            <NewDocumentPicker />
                          </Show>
                          <DocumentContent
                            spaceId={currentSpace()?.id as string}
                            documentType={documentType()}
                          />
                        </>
                      }
                    >
                      <RevisionView
                        documentId={doc()?.id as string}
                        documentType={documentType()}
                        spaceId={currentSpace()?.id as string}
                      />

                      <Switch
                        fallback={
                          <DocumentContent
                            spaceId={currentSpace()?.id as string}
                            documentId={doc()?.id}
                            initialHtml={doc()?.content}
                            documentType={documentType()}
                            readonly={isReadonly()}
                          />
                        }
                      >
                        <Match when={isApp()}>
                          <AppView html={doc()?.content || ""} />
                        </Match>
                        <Match when={isWorkflow()}>
                          <WorkflowView
                            documentId={doc()?.id as string}
                            spaceId={currentSpace()?.id as string}
                          />
                        </Match>
                        <Match when={isDatabase()}>
                          <DatabaseDocumentView
                            databaseDocumentId={doc()?.id as string}
                            spaceId={currentSpace()?.id as string}
                            views={databaseViews()}
                            viewConfig={doc()?.properties._databaseViews}
                            schemaJson={
                              optionalPropertyValueToText(doc()?.properties._schema) ??
                              undefined
                            }
                          />
                        </Match>
                        <Match when={isCanvas()}>
                          <CanvasView
                            documentId={doc()?.id}
                            spaceId={currentSpace()?.id as string}
                          />
                        </Match>
                        <Match when={isCsv()}>
                          <CsvView
                            documentId={doc()?.id as string}
                            initialHtml={doc()?.content}
                          />
                        </Match>
                      </Switch>
                    </Show>
                  </div>

                  {/* Not under a spreadsheet: it is the last flex child, so its
                      ~90px of margins came straight off the grid's height and
                      left it hanging short of the window. The grid runs to the
                      bottom edge instead, and "Updated …" lives in the ⋮ menu's
                      document info. */}
                  <Show when={!isDraft() && !editing() && !isCanvas() && !isCsv()}>
                    <inset-view class="mt-2xs mb-4xs flex items-center justify-end px-xs md:px-m print:px-0">
                      <Show when={doc()?.updatedAt}>
                        <div class="mb-12 flex flex-wrap items-center gap-2 text-neutral-500 text-size-medium">
                          <Show when={hasMounted() && updatedAtStr()}>
                            <span>Updated {updatedAtStr()}</span>
                          </Show>
                        </div>
                      </Show>
                    </inset-view>
                  </Show>
                </div>

                <DocumentExtensionViews
                  views={documentRightViews()}
                  documentId={doc()?.id as string}
                  spaceId={currentSpace()?.id as string}
                />
              </div>
            </div>
          </inset-view>
        </div>
      </Show>

      <Show when={hasMounted() && !isDraft() && doc()}>
        {(document) => (
          <Portal>
            <RevisionsSidebar documentId={document().id} />
          </Portal>
        )}
      </Show>
    </>
  );
}
