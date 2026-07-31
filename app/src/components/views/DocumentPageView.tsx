import { useLocation, useNavigate } from "@solidjs/router";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { twMerge } from "tailwind-merge";
import { api } from "#api/client.ts";
import { AppView } from "#components/AppView.tsx";
import { Breadcrumbs } from "#components/Breadcrumbs.tsx";
import { DatabaseView } from "#components/DatabaseView.tsx";
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
import { useQuery } from "#composeables/query.solid.ts";
import { useDocumentContext } from "#composeables/useDocument.solid.ts";
import { editing, resetEditingState } from "#composeables/useEditor.solid.ts";
import { useExtensions } from "#composeables/useExtensions.solid.ts";
import { usePageTitle } from "#composeables/usePageTitle.solid.ts";
import { canEdit } from "#composeables/usePermissions.ts";
import { useSpace } from "#composeables/useSpace.solid.ts";
import { optionalPropertyValueToText } from "#documents/properties.ts";
import { readOnlyDocumentTypes } from "#documents/types.ts";
import { formatRelativeTime } from "#utils/datetime.ts";
import { isWorkflowCreationEnabled } from "#utils/spacePreferences.ts";
import { spacePath } from "#utils/utils.ts";

interface Props {
  documentSlug?: string;
  draftType?: string;
  draftCategory?: string;
  /** The server's clock, so the first "Updated …" matches the SSR output. */
  ssrNow?: number;
}

const AUTO_CREATE_TYPES: Record<string, { title: string; content: string }> = {
  database: { title: "Untitled Database", content: "<p></p>" },
  canvas: {
    title: "Untitled Canvas",
    content: JSON.stringify({ version: 1, shapes: [], strokes: [] }),
  },
  workflow: { title: "Untitled Workflow", content: "" },
};

const STICKY_HEADER_CLASS =
  "flex min-h-7 flex-row items-center justify-between gap-6 px-xs py-4 md:px-xl sticky top-0 z-10";

export function DocumentPageView(props: Props) {
  const navigate = useNavigate();
  const location = useLocation();
  const [now, setNow] = createSignal(props.ssrNow ?? Date.now());

  const { currentSpace } = useSpace();
  const { extensions } = useExtensions();
  const { canUseDocumentEditor, setDocumentContext, resetDocumentContext } =
    useDocumentContext();

  const isDraft = createMemo(() => !props.documentSlug);
  const draftTypeParam = createMemo(() => props.draftType ?? "");
  const showPicker = createMemo(() => isDraft() && !draftTypeParam());
  const draftCategory = createMemo(() =>
    isDraft() ? props.draftCategory || undefined : undefined,
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
    const fullPath = `${location.pathname}${location.search}${location.hash}`;
    navigate(fullPath.replace(`/doc/${props.documentSlug}`, `/doc/${d.slug}`), {
      replace: true,
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
  const isPaddedDocument = createMemo(
    () => !isCanvas() && !isApp() && !isCsv() && !isWorkflow() && !isDatabase(),
  );

  const documentRightViews = createMemo(() => {
    if (isDraft() || documentType() !== "document") return [];

    return extensions().flatMap((extension) =>
      (extension.routes || [])
        .filter((route) => route.placements?.includes("document"))
        .map((route) => ({ extensionId: extension.id, route })),
    );
  });

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
      ? documentType() === "canvas"
        ? "Untitled Canvas"
        : "Untitled Document"
      : (doc()?.properties?.title as string) || "Untitled Document",
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
          title: autoCreate.title,
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
        <div>
          <inset-view
            class={twMerge(
              "block min-h-0 flex-1",
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
                isCsv() || isDatabase() || effectiveLayout() === "full"
                  ? "max-w-full"
                  : "max-w-(--document-width)",
              )}
            >
              <Show when={doc()?.archived}>
                <div class="mx-4 border-yellow-400 border-l-4 bg-yellow-50 p-4 md:mx-10">
                  <div class="flex items-start justify-between gap-3">
                    <div class="space-y-2">
                      <div class="font-semibold text-size-medium text-yellow-600">
                        ⚠️ This document is archived
                      </div>
                      <p class="text-size-medium text-yellow-700">
                        This document has been archived and is no longer actively
                        maintained.
                      </p>
                    </div>
                    <RestoreButton documentId={doc()?.id as string} />
                  </div>
                </div>
              </Show>

              <Show when={isCanvas()}>
                <div class="pointer-events-none absolute top-0 right-0 left-0 z-20 block md:right-(--inset-right) md:left-(--inset-left)">
                  <div class={STICKY_HEADER_CLASS}>
                    <div>{breadcrumbs()}</div>
                    <DocumentActions title={title()} />
                  </div>

                  <inset-view class="flex flex-row justify-between gap-6 px-xs py-3xs md:gap-4 md:px-xl print:px-0">
                    {titleRow()}
                  </inset-view>

                  <inset-view
                    id="document-properties"
                    class="mb-l block px-xs md:px-xl print:px-0"
                  >
                    {documentPropertiesBlock()}
                  </inset-view>
                </div>
              </Show>

              {/* Portrait header image: image column beside the title/properties */}
              <Show when={!isCanvas() && !isApp() && isPortraitHeader()}>
                <div class={`${STICKY_HEADER_CLASS} bg-neutral-10`}>
                  <div>{breadcrumbs()}</div>
                  <DocumentActions title={title()} />
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

                <div class={`${STICKY_HEADER_CLASS} bg-neutral-10`}>
                  <Show when={isWorkflow()} fallback={<div>{breadcrumbs()}</div>}>
                    <div id="workflow-breadcrumb-slot" />
                  </Show>
                  <DocumentActions title={title()} />
                </div>

                <inset-view class="flex flex-row justify-between gap-6 bg-neutral-10 px-xs py-3xs md:gap-4 md:px-xl print:px-0">
                  {titleRow()}
                </inset-view>

                <inset-view
                  id="document-properties"
                  class="mb-l block px-xs md:px-xl print:px-0"
                >
                  {documentPropertiesBlock()}
                </inset-view>
              </Show>

              <div
                class={twMerge(
                  documentRightViews().length > 0 &&
                    "lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-6",
                )}
              >
                <div class="min-w-0">
                  <div
                    class={twMerge(
                      "h-full max-w-none overflow-x-auto text-neutral-700",
                      isCsv() || isDatabase()
                        ? "flex min-h-0 flex-1 flex-col overflow-hidden"
                        : "h-full overflow-x-auto",
                      isPaddedDocument() && "px-xs md:px-xl print:px-0",
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

                      <Show when={isApp()}>
                        <AppView html={doc()?.content || ""} />
                      </Show>
                      <Show when={!isApp() && isWorkflow()}>
                        <WorkflowView
                          documentId={doc()?.id as string}
                          spaceId={currentSpace()?.id as string}
                        />
                      </Show>
                      <Show when={!isApp() && !isWorkflow() && isDatabase()}>
                        <DatabaseView
                          databaseDocumentId={doc()?.id as string}
                          schemaJson={
                            optionalPropertyValueToText(doc()?.properties._schema) ??
                            undefined
                          }
                        />
                      </Show>
                      <Show when={!isApp() && !isWorkflow() && !isDatabase()}>
                        <DocumentContent
                          spaceId={currentSpace()?.id as string}
                          documentId={doc()?.id}
                          initialHtml={doc()?.content}
                          documentType={documentType()}
                          readonly={isReadonly()}
                        />
                      </Show>
                    </Show>
                  </div>

                  <Show when={!isDraft() && !editing() && !isCanvas()}>
                    <inset-view class="mt-2xs mb-4xs flex items-center justify-end px-xs md:px-xl print:px-0">
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
